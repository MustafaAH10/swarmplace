import { spawn } from "node:child_process";
// No child stdout/stderr is logged. SIGINT/SIGTERM, abort and timeout kill the whole group.
export function runBounded(
  command,
  args,
  { cwd, env, input, timeoutMs, maxBytes = 1000000, signal, onSpawn } = {},
) {
  return new Promise((resolve, reject) => {
    let output = "",
      cancelled = false,
      overflow = false;
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      detached: process.platform !== "win32",
    });
    const kill = () => {
      try {
        if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {}
    };
    const cancel = () => {
      cancelled = true;
      kill();
    };
    const timer = setTimeout(kill, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      process.removeListener("SIGINT", cancel);
      process.removeListener("SIGTERM", cancel);
      signal?.removeEventListener("abort", cancel);
    };
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    signal?.addEventListener("abort", cancel, { once: true });
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      if (output.length > maxBytes) {
        overflow = true;
        kill();
      }
    });
    child.stderr.on("data", () => {});
    child.stdin.on("error", () => {});
    child.on("error", () => {
      cleanup();
      reject(
        new Error(
          "Claude Code is unavailable. Install it and run claude auth login locally.",
        ),
      );
    });
    child.on("close", (code) => {
      cleanup();
      if (cancelled)
        return reject(
          new Error("Painting cancelled. The local model process was stopped."),
        );
      resolve({ code, output, overflow });
    });
    onSpawn?.(child.pid);
    if (signal?.aborted) cancel();
    child.stdin.end(input);
  });
}
