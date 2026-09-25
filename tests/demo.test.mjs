import test from "node:test";
import assert from "node:assert/strict";
import { runDemo, pause } from "../shared/demo.mjs";
import { fetchSnapshot } from "../shared/snapshot-fetch.mjs";

const region = { x: 20, y: 20, w: 1, h: 1 };
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
for (const blocked of ["pair", "connect"])
  test(`Stop revokes late ${blocked} responses before any painting`, async () => {
    const controller = new AbortController(),
      waiting = deferred(),
      entered = deferred(),
      calls = [];
    const request = async (path) => {
      calls.push(path);
      if (path === blocked) {
        entered.resolve();
        await waiting.promise;
      }
      return { owner: "owner", code: "code", token: "token" };
    };
    const done = runDemo({ region, request, signal: controller.signal });
    await entered.promise;
    controller.abort();
    waiting.resolve();
    await done;
    assert.ok(calls.includes("stop"));
    assert.ok(!calls.includes("paint"));
    if (blocked === "pair") assert.ok(!calls.includes("connect"));
  });
test("demo heartbeat stays active during slow work and stops after cancellation", async () => {
  const controller = new AbortController(),
    firstPaint = deferred(),
    heart = deferred(),
    calls = [];
  const request = async (path) => {
    calls.push(path);
    if (path === "paint") firstPaint.resolve();
    if (path === "heartbeat") heart.resolve();
    return { owner: "owner", code: "code", token: "token" };
  };
  const done = runDemo({
    region,
    request,
    signal: controller.signal,
    heartbeatMs: 5,
    delay: (_ms, signal) => pause(1000, signal),
  });
  await firstPaint.promise;
  await heart.promise;
  controller.abort();
  await done;
  const count = calls.length;
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls.length, count);
  assert.equal(calls.filter((x) => x === "paint").length, 1);
  assert.equal(calls.at(-1), "stop");
});
test("failed connection setup still revokes its owner capability", async () => {
  const calls = [];
  await assert.rejects(
    () =>
      runDemo({
        region,
        signal: new AbortController().signal,
        request: async (path) => {
          calls.push(path);
          if (path === "connect") throw new Error("unavailable");
          return { owner: "owner" };
        },
      }),
    /unavailable/,
  );
  assert.deepEqual(calls, ["pair", "connect", "stop"]);
});
test("an obsolete snapshot stops paging and never returns a stale map", async () => {
  const controller = new AbortController(),
    response = deferred(),
    entered = deferred();
  let requests = 0;
  const done = fetchSnapshot(
    region,
    async () => {
      requests++;
      entered.resolve();
      await response.promise;
      return {
        head: 100,
        events: Array.from({ length: 100 }, (_, i) => ({ seq: i + 1 })),
      };
    },
    undefined,
    controller.signal,
  );
  await entered.promise;
  controller.abort();
  response.resolve();
  await assert.rejects(() => done, { name: "AbortError" });
  assert.equal(requests, 1);
});
