import { seededTile, tileKey, applyPatches } from "./world.mjs";
// Build away from the live cache, then overlay events newer than the snapshot.
export function buildSnapshot(bounds, snapshotEvents, head, liveEvents = []) {
  const result = new Map();
  const wanted = (x, y) =>
    x >= bounds.x &&
    x < bounds.x + bounds.w &&
    y >= bounds.y &&
    y < bounds.y + bounds.h;
  for (
    let y = Math.max(0, bounds.y);
    y < Math.min(10, bounds.y + bounds.h);
    y++
  )
    for (
      let x = Math.max(0, bounds.x);
      x < Math.min(16, bounds.x + bounds.w);
      x++
    )
      result.set(tileKey(x, y), seededTile(x, y));
  const scratch = new Uint8Array(1024);
  const get = (x, y) => {
    if (!wanted(x, y)) return scratch;
    const k = tileKey(x, y);
    if (!result.has(k))
      result.set(k, seededTile(x, y) || new Uint8Array(1024).fill(255));
    return result.get(k);
  };
  for (const e of [
    ...snapshotEvents.filter((e) => e.seq <= head),
    ...liveEvents.filter((e) => e.seq > head),
  ].sort((a, b) => a.seq - b.seq))
    if (e.kind === "paint") applyPatches(get, e.data.patches);
  return result;
}
