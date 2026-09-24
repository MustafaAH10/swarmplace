import test from "node:test";
import assert from "node:assert/strict";
import {
  TILE,
  seededTile,
  makePatches,
  applyPatches,
  tileKey,
  tileAt,
  zoomAt,
  screenToWorld,
  regionPixels,
  LRU,
  estimateTokens,
} from "../shared/world.mjs";
import { rasterize } from "../cli/renderer.mjs";
test("negative tile coordinates use floor; zoom preserves pointer world position", () => {
  assert.equal(tileAt(-1), -1);
  assert.equal(tileAt(-32), -1);
  assert.equal(tileAt(-33), -2);
  const c = { x: -100, y: 32, zoom: 2 },
    p = { x: 110, y: 173 };
  assert.deepEqual(
    screenToWorld(p, c, 800, 600),
    screenToWorld(p, zoomAt(c, 2, p, 800, 600), 800, 600),
  );
});
test("adjacent procedural regions join identically and replay is deterministic", () => {
  const r = { x: -1, y: 0, w: 2, h: 1 },
    one = makePatches(r),
    parts = [
      ...makePatches({ ...r, w: 1 }),
      ...makePatches({ x: 0, y: 0, w: 1, h: 1 }),
    ];
  const render = (p) => {
    const m = new Map();
    applyPatches((x, y) => {
      const k = tileKey(x, y);
      if (!m.has(k)) m.set(k, new Uint8Array(1024).fill(255));
      return m.get(k);
    }, p);
    return m;
  };
  const a = render(one),
    b = render(parts);
  assert.deepEqual(a, b);
  assert.deepEqual(render(one), a);
  assert.deepEqual(seededTile(2, 3), seededTile(2, 3));
});
test("rectangle writes cross tile borders correctly", () => {
  const tiles = new Map();
  applyPatches(
    (x, y) => {
      const k = tileKey(x, y);
      if (!tiles.has(k)) tiles.set(k, new Uint8Array(1024));
      return tiles.get(k);
    },
    [{ x: -1, y: -1, w: 2, h: 2, c: 7 }],
  );
  assert.equal(tiles.size, 4);
  assert.equal(tiles.get("-1,-1")[1023], 7);
  assert.equal(tiles.get("0,0")[0], 7);
});
test("model shapes are rasterized and clipped inside assigned region", () => {
  const r = { x: -3, y: 9, w: 1, h: 1 };
  const patches = rasterize(
    {
      shapes: [
        { type: "rect", x: 0, y: 0, w: 256, h: 256, c: 2 },
        { type: "ellipse", x: 16, y: 16, w: 30, h: 30, c: 7 },
      ],
    },
    r,
  );
  assert.equal(
    patches.reduce((n, p) => n + p.w * p.h, 0),
    1024,
  );
  for (const p of patches) {
    assert.ok(p.x >= -96 && p.x + p.w <= -64);
    assert.ok(p.y >= 288 && p.y + p.h <= 320);
  }
  assert.throws(() =>
    rasterize({ shapes: [{ type: "rect", x: 0, y: 0, w: 1, h: 1, c: 16 }] }, r),
  );
  assert.throws(() => rasterize({ shapes: [], thoughts: "x" }, r));
});
test("selection cost scales by pixel area and cache has a firm memory bound", () => {
  const small = { x: 0, y: 0, w: 1, h: 1 },
    big = { ...small, w: 2 };
  assert.equal(regionPixels(big), regionPixels(small) * 2);
  assert.ok(estimateTokens(big) > estimateTokens(small));
  const cache = new LRU(2);
  cache.set("a", 1);
  cache.set("b", 2);
  cache.get("a");
  cache.set("c", 3);
  assert.equal(cache.get("b"), undefined);
  assert.equal(cache.items.size, 2);
});
import { buildSnapshot } from "../shared/snapshot.mjs";
test("late viewport snapshots cannot overwrite newer overlapping paint", () => {
  const event = (seq, c) => ({
    seq,
    kind: "paint",
    data: { patches: [{ x: 0, y: 0, w: 2, h: 2, c }] },
  });
  const map = buildSnapshot({ x: 0, y: 0, w: 1, h: 1 }, [event(1, 3)], 1, [
    event(1, 3),
    event(2, 7),
  ]);
  assert.equal(map.get("0,0")[0], 7);
  assert.equal(map.get("0,0")[2], seededTile(0, 0)[2]);
});
