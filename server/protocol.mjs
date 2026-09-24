import {
  validRegion,
  inside,
  PALETTE,
  PHASES,
  regionPixels,
} from "../shared/world.mjs";
export class Fault extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
export function exact(obj, keys) {
  if (
    !obj ||
    typeof obj !== "object" ||
    Array.isArray(obj) ||
    Object.keys(obj).some((k) => !keys.includes(k))
  )
    throw new Fault(
      400,
      "Unexpected fields. Publish structured painting data only.",
    );
}
export function setupInput(b) {
  exact(b, ["region", "budget", "tokenBudget", "mode"]);
  if (!validRegion(b.region))
    throw new Fault(400, "Select between 1 and 8 tiles per side.");
  exact(b.region, ["x", "y", "w", "h"]);
  if (!["claude", "simulation", "replay"].includes(b.mode))
    throw new Fault(400, "Unknown agent mode.");
  if (
    !Number.isInteger(b.budget) ||
    b.budget < 1 ||
    b.budget > regionPixels(b.region) * 5
  )
    throw new Fault(
      400,
      "Paint budget must be at most five passes of the selection.",
    );
  if (
    !Number.isInteger(b.tokenBudget) ||
    b.tokenBudget < 1000 ||
    b.tokenBudget > 64000
  )
    throw new Fault(400, "Token budget must be 1,000–64,000.");
  return b;
}
export function paintInput(b, run) {
  exact(b, ["op", "phase", "patches", "usage"]);
  if (typeof b.op !== "string" || !/^[-a-zA-Z0-9]{16,64}$/.test(b.op))
    throw new Fault(400, "An idempotency key is required.");
  if (!PHASES.includes(b.phase))
    throw new Fault(400, "Choose a public painting phase.");
  if (!Array.isArray(b.patches) || !b.patches.length || b.patches.length > 128)
    throw new Fault(400, "Send 1–128 paint commands.");
  let cost = 0;
  for (const p of b.patches) {
    exact(p, ["x", "y", "w", "h", "c"]);
    if (
      !["x", "y", "w", "h", "c"].every((k) => Number.isInteger(p[k])) ||
      p.w < 1 ||
      p.h < 1 ||
      p.w > 32 ||
      p.h > 32 ||
      p.c < 0 ||
      p.c >= PALETTE.length ||
      !inside(run.region, p)
    )
      throw new Fault(
        403,
        "Paint commands must stay inside the assigned selection and palette.",
      );
    cost += p.w * p.h;
  }
  if (b.usage) {
    exact(b.usage, ["input", "output"]);
    if (
      !["input", "output"].every(
        (k) =>
          Number.isInteger(b.usage[k]) &&
          b.usage[k] >= 0 &&
          b.usage[k] <= 1000000,
      )
    )
      throw new Fault(400, "Invalid usage counters.");
  }
  return cost;
}
export const token = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(24)), (x) =>
    x.toString(16).padStart(2, "0"),
  ).join("");
export async function digest(s) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)),
    ),
    (x) => x.toString(16).padStart(2, "0"),
  ).join("");
}
