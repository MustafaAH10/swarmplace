import test from "node:test";
import assert from "node:assert/strict";
import { replayPatches, schemaForRegion } from "../cli/renderer.mjs";
import { runBounded } from "../cli/process.mjs";
import { SnapshotGate } from "../shared/snapshot-gate.mjs";
test("replay rejects private patch fields before any network transmission", () => {
  const r = { x: 0, y: 0, w: 1, h: 1 },
    saved = {
      version: 1,
      region: r,
      patches: [{ x: 0, y: 0, w: 1, h: 1, c: 2, privateBrief: "secret" }],
    };
  assert.throws(() => replayPatches(saved, r), /private fields/);
  delete saved.patches[0].privateBrief;
  assert.deepEqual(replayPatches(saved, r), [{ x: 0, y: 0, w: 1, h: 1, c: 2 }]);
});
test("Claude schema bounds match the actual region", () => {
  const p = schemaForRegion({ w: 1, h: 2 }).properties.shapes.items.properties;
  assert.equal(p.x.maximum, 31);
  assert.equal(p.y.maximum, 63);
  assert.equal(p.w.maximum, 32);
  assert.equal(p.h.maximum, 64);
});
test("cancellation kills the detached model and removes signal handlers", async () => {
  const before = process.listenerCount("SIGINT"),
    controller = new AbortController();
  let pid;
  const result = runBounded(
    process.execPath,
    ["-e", "setInterval(()=>{},1000)"],
    {
      input: "",
      timeoutMs: 10000,
      signal: controller.signal,
      onSpawn: (p) => {
        pid = p;
        setTimeout(() => controller.abort(), 50);
      },
    },
  );
  await assert.rejects(result, /cancelled/);
  assert.equal(process.listenerCount("SIGINT"), before);
  assert.throws(() => process.kill(pid, 0));
});
test("snapshot loading waits for bootstrap and terminal failures do not redownload", () => {
  const gate = new SnapshotGate();
  assert.equal(gate.begin("view"), false);
  gate.activate();
  assert.equal(gate.begin("view"), true);
  gate.fail(true);
  assert.equal(gate.begin("view", Date.now() + 100000), false);
  assert.equal(gate.begin("new-view"), true);
  gate.success();
  assert.equal(gate.begin("new-view"), false);
});
test("transient snapshot failures back off but viewport changes may proceed", () => {
  const g = new SnapshotGate();
  g.activate();
  g.begin("a", 0);
  g.fail(false, 0);
  assert.equal(g.begin("a", 999), false);
  assert.equal(g.begin("a", 1000), true);
  g.fail(false, 1000);
  assert.equal(g.begin("a", 2999), false);
  assert.equal(g.begin("b", 1500), true);
});
