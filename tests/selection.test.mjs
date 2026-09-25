import test from "node:test";
import assert from "node:assert/strict";
import {
  selectionHash,
  parseSelectionHash,
  splitSelection,
  selectionRGBA,
} from "../shared/selection.mjs";
import {
  inside,
  makePatches,
  regionPixels,
  PALETTE,
} from "../shared/world.mjs";
import { buildSnapshot } from "../shared/snapshot.mjs";
import { fetchSnapshot } from "../shared/snapshot-fetch.mjs";

test("share links preserve bounded negative selections and reject extra private fields", () => {
  const r = { x: -32768, y: 32760, w: 8, h: 8 };
  assert.deepEqual(parseSelectionHash(selectionHash(r)), r);
  for (const hash of [
    "#selection=1,2,9,1",
    "#selection=32768,0,1,1",
    "#selection=0,0,1,1&token=secret",
    "#selection=0.5,0,1,1",
    "#selection=Infinity,0,1,1",
  ])
    assert.equal(parseSelectionHash(hash), null);
});
test("all swarm shapes cover the selection exactly once, with coherent scoped paint and credits", () => {
  for (let w = 1; w <= 8; w++)
    for (let h = 1; h <= 8; h++) {
      const source = { x: -4, y: -3, w, h },
        parts = splitSelection(source),
        covered = new Set();
      assert.equal(parts.length, Math.min(4, w * h));
      for (const part of parts) {
        for (let y = part.y; y < part.y + part.h; y++)
          for (let x = part.x; x < part.x + part.w; x++) {
            const key = `${x},${y}`;
            assert.ok(!covered.has(key));
            covered.add(key);
          }
        let spent = 0;
        for (const phase of ["underpainting", "blocking", "texture"])
          for (const patch of makePatches(part, phase, 0)) {
            assert.ok(inside(source, patch));
            assert.ok(inside(part, patch));
            spent += patch.w * patch.h;
          }
        assert.equal(spent, regionPixels(part) * 3);
      }
      assert.equal(covered.size, w * h);
      for (let y = source.y; y < source.y + h; y++)
        for (let x = source.x; x < source.x + w; x++)
          assert.ok(covered.has(`${x},${y}`));
    }
});
test("PNG pixels match frozen history with transparent blanks and cross-tile paint", () => {
  const r = { x: -2, y: -1, w: 2, h: 1 };
  const events = [
    {
      seq: 1,
      kind: "paint",
      data: { patches: [{ x: -33, y: -1, w: 2, h: 1, c: 4 }] },
    },
    {
      seq: 2,
      kind: "paint",
      data: { patches: [{ x: -33, y: -1, w: 2, h: 1, c: 9 }] },
    },
  ];
  const output = selectionRGBA(r, buildSnapshot(r, events, 1));
  assert.equal(output.width, 64);
  assert.equal(output.height, 32);
  assert.deepEqual([...output.rgba.slice(0, 4)], [0, 0, 0, 0]);
  const rgb = [1, 3, 5].map((i) => parseInt(PALETTE[4].slice(i, i + 2), 16));
  for (const x of [31, 32])
    assert.deepEqual(
      [...output.rgba.slice((31 * 64 + x) * 4, (31 * 64 + x) * 4 + 4)],
      [...rgb, 255],
    );
});
test("snapshot pagination pins the head and rejects changed or nonprogressing pages", async () => {
  const region = { x: 0, y: 0, w: 1, h: 1 },
    calls = [];
  const first = Array.from({ length: 100 }, (_, i) => ({ seq: i + 1 }));
  const result = await fetchSnapshot(region, async (q) => {
    calls.push(Object.fromEntries(q));
    return {
      head: 101,
      events: q.get("after") === "0" ? first : [{ seq: 101 }],
    };
  });
  assert.equal(result.events.length, 101);
  assert.equal(calls[1].head, "101");
  assert.equal(calls[1].after, "100");
  await assert.rejects(
    () => fetchSnapshot(region, async () => ({ head: 6, events: [] }), 5),
    /changed/,
  );
  await assert.rejects(
    () =>
      fetchSnapshot(region, async () => ({
        head: 1,
        events: Array(100).fill({ seq: 0 }),
      })),
    /cursor/,
  );
});
