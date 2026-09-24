import { performance } from "node:perf_hooks";
import { makePatches, applyPatches, tileKey, LRU } from "../shared/world.mjs";
const cache = new LRU(2048),
  batches = Array.from({ length: 128 }, (_, i) =>
    makePatches({ x: i % 16, y: Math.floor(i / 16), w: 1, h: 1 }, "texture"),
  );
const get = (x, y) => {
  const key = tileKey(x, y);
  return cache.get(key) || cache.set(key, new Uint8Array(1024));
};
const times = [];
for (let frame = 0; frame < 120; frame++) {
  const start = performance.now();
  for (const patches of batches) applyPatches(get, patches);
  times.push(performance.now() - start);
}
times.sort((a, b) => a - b);
console.log(
  JSON.stringify(
    {
      frames: 120,
      simultaneousAgents: 128,
      pixelWritesPerFrame: 131072,
      cachedTiles: cache.items.size,
      compositorMeanMs: +(times.reduce((a, b) => a + b) / times.length).toFixed(
        2,
      ),
      compositorP95Ms: +times[114].toFixed(2),
      note: "CPU tile-compositor benchmark; excludes browser drawing, network and display frame pacing.",
    },
    null,
    2,
  ),
);
