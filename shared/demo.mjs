import { splitSelection } from "./selection.mjs";
import { makePatches, regionPixels } from "./world.mjs";

export function pause(ms, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", abort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      cleanup();
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

export async function runDemo({
  region,
  request,
  signal,
  onOwner = (_owner) => {},
  delay = pause,
  heartbeatMs = 20000,
}) {
  const outcomes = await Promise.allSettled(
    splitSelection(region).map(async (r, i) => {
      let owner, heartbeat;
      try {
        signal.throwIfAborted();
        // Await setup even after cancellation so every issued capability can be revoked.
        const pair = await request("pair", {
          region: r,
          budget: regionPixels(r) * 3,
          tokenBudget: 1000,
          mode: "simulation",
        });
        owner = pair.owner;
        signal.throwIfAborted();
        onOwner(owner);
        const session = await request("connect", { code: pair.code });
        signal.throwIfAborted();
        let sendingHeartbeat = false;
        heartbeat = setInterval(async () => {
          if (signal.aborted || sendingHeartbeat) return;
          sendingHeartbeat = true;
          try {
            await request("heartbeat", {}, session.token);
          } catch {
          } finally {
            sendingHeartbeat = false;
          }
        }, heartbeatMs);
        for (const phase of ["underpainting", "blocking", "texture"]) {
          const patches = makePatches(r, phase, 0);
          for (let j = 0; j < patches.length; j += 64) {
            const payload = {
              op: crypto.randomUUID(),
              phase,
              patches: patches.slice(j, j + 64),
              usage: { input: 0, output: 0 },
            };
            for (let retry = 0; retry < 6; retry++) {
              signal.throwIfAborted();
              try {
                await request("paint", payload, session.token);
                break;
              } catch (e) {
                if (![429, 409, 503].includes(e.status) || retry === 5) throw e;
                await delay(500 * (retry + 1), signal);
              }
            }
            await delay(350 + i * 30, signal);
          }
        }
      } finally {
        clearInterval(heartbeat);
        if (owner) await request("stop", {}, owner).catch(() => {});
      }
    }),
  );
  if (signal.aborted) return;
  const failed = outcomes.find((o) => o.status === "rejected");
  if (failed) throw failed.reason;
}
