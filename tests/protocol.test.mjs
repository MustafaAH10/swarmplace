import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { database } from "./db.mjs";
import { handleAPI, eventPage } from "../server/api.mjs";
const setup = {
  region: { x: 0, y: 0, w: 1, h: 1 },
  budget: 2048,
  tokenBudget: 8000,
  mode: "simulation",
};
function client(db) {
  return async (path, body, token, headers = {}) => {
    const r = await handleAPI(
      new Request("https://world.test/api/" + path, {
        method: body ? "POST" : "GET",
        headers: {
          ...(body ? { "content-type": "application/json" } : {}),
          ...(token ? { authorization: "Bearer " + token } : {}),
          ...headers,
        },
        body: body ? JSON.stringify(body) : undefined,
      }),
      { DB: db },
    );
    return { status: r.status, ...(await r.json()) };
  };
}
async function connected(db, extra = {}) {
  const call = client(db),
    p = await call("pair", { ...setup, ...extra });
  assert.equal(p.status, 201);
  const s = await call("connect", { code: p.code });
  assert.equal(s.status, 200);
  return { call, p, s };
}
const paint = (extra = {}) => ({
  op: randomUUID(),
  phase: "color",
  patches: [{ x: 0, y: 0, w: 32, h: 32, c: 3 }],
  usage: { input: 1, output: 1 },
  ...extra,
});
test("one-time pairing, hashed secrets and capability expiry", async () => {
  const db = database();
  try {
    const { call, p, s } = await connected(db);
    assert.equal((await call("connect", { code: p.code })).status, 401);
    assert.ok(
      !JSON.stringify(
        db.sqlite.prepare("SELECT * FROM sessions").all(),
      ).includes(s.token),
    );
    assert.equal((await call("me", undefined, s.token)).status, 200);
    db.sqlite.exec("UPDATE sessions SET expires=0");
    assert.equal((await call("me", undefined, s.token)).status, 401);
  } finally {
    db.close();
  }
});
test("simultaneous pairing redemptions issue exactly one session", async () => {
  const db = database();
  try {
    const c = client(db),
      p = await c("pair", setup);
    const res = await Promise.all([
      c("connect", { code: p.code }),
      c("connect", { code: p.code }),
    ]);
    assert.equal(res.filter((r) => r.status === 200).length, 1);
  } finally {
    db.close();
  }
});
test("scope, palette, fractional geometry, secrets and unknown fields rejected", async () => {
  const db = database();
  try {
    const { call, s } = await connected(db);
    for (const patches of [
      [{ x: -1, y: 0, w: 1, h: 1, c: 0 }],
      [{ x: 31, y: 0, w: 2, h: 1, c: 0 }],
      [{ x: 0, y: 0, w: 1, h: 1, c: 16 }],
      [{ x: 0.1, y: 0, w: 1, h: 1, c: 0 }],
      [{ x: 0, y: 0, w: 1, h: 1, c: 0, prompt: "secret" }],
    ])
      assert.ok(
        (await call("paint", paint({ patches }), s.token)).status >= 400,
      );
    assert.equal(
      (await call("paint", { ...paint(), thoughts: "secret" }, s.token)).status,
      400,
    );
    assert.equal((await call("paint", paint(), undefined)).status, 401);
    assert.equal(
      db.sqlite
        .prepare("SELECT COUNT(*) AS n FROM events WHERE kind=?")
        .get("paint").n,
      0,
    );
  } finally {
    db.close();
  }
});
test("write accounting is atomic, rate-limited and idempotent", async () => {
  const db = database();
  try {
    const { call, s } = await connected(db),
      b = paint();
    const res = await Promise.all([
      call("paint", b, s.token),
      call("paint", b, s.token),
    ]);
    assert.ok(res.some((r) => r.status === 200));
    assert.equal(db.sqlite.prepare("SELECT used FROM runs").get().used, 1024);
    assert.equal((await call("paint", b, s.token)).duplicate, true);
    assert.equal((await call("paint", paint(), s.token)).status, 429);
    db.sqlite.exec("UPDATE runs SET next_write=0");
    assert.equal((await call("paint", paint(), s.token)).status, 200);
    db.sqlite.exec("UPDATE runs SET next_write=0");
    assert.equal((await call("paint", paint(), s.token)).status, 402);
  } finally {
    db.close();
  }
});
test("concurrent different commands cannot lose accounting", async () => {
  const db = database();
  try {
    const { call, s } = await connected(db);
    const res = await Promise.all([
      call("paint", paint(), s.token),
      call("paint", paint(), s.token),
    ]);
    assert.equal(res.filter((r) => r.status === 200).length, 1);
    assert.equal(db.sqlite.prepare("SELECT used FROM runs").get().used, 1024);
    assert.equal(
      db.sqlite
        .prepare("SELECT COUNT(*) n FROM events WHERE kind='paint'")
        .get().n,
      1,
    );
  } finally {
    db.close();
  }
});
test("overlapping claims remain soft; session cannot escape its scope", async () => {
  const db = database();
  try {
    const a = await connected(db),
      b = await connected(db);
    assert.deepEqual(b.p.conflicts, [a.s.run.id]);
    await a.call("paint", paint(), a.s.token);
    await b.call(
      "paint",
      paint({ patches: [{ x: 0, y: 0, w: 1, h: 1, c: 7 }] }),
      b.s.token,
    );
    assert.equal(
      (await eventPage(db)).filter((e) => e.kind === "paint").length,
      2,
    );
    assert.equal(
      (
        await a.call(
          "proposal",
          { target: b.s.run.id, kind: "blend-edge" },
          a.s.token,
        )
      ).status,
      200,
    );
  } finally {
    db.close();
  }
});
test("reconnect cursor and bounded snapshot reproduce canonical paint order", async () => {
  const db = database();
  try {
    const a = await connected(db);
    await a.call("paint", paint(), a.s.token);
    const h = (await a.call("world")).head;
    await a.call("stop", {}, a.s.token);
    const events = await eventPage(db, h);
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, "stop");
    const snap = await a.call("snapshot?x=0&y=0&w=1&h=1");
    assert.equal(snap.events.length, 1);
    assert.equal((await a.call("snapshot?x=8&y=8&w=1&h=1")).events.length, 0);
    assert.equal((await a.call("paint", paint(), a.s.token)).status, 401);
  } finally {
    db.close();
  }
});
test("reject cross-origin requests, oversized bodies and unknown prompts", async () => {
  const db = database();
  try {
    const c = client(db);
    assert.equal(
      (await c("pair", setup, undefined, { origin: "https://evil.test" }))
        .status,
      403,
    );
    assert.equal(
      (await c("pair", { ...setup, prompt: "private" })).status,
      400,
    );
    assert.equal(
      (await c("pair", { ...setup, prompt: "x".repeat(40000) })).status,
      413,
    );
    assert.equal(
      (await c("pair", { ...setup, region: { x: 32768, y: 0, w: 1, h: 1 } }))
        .status,
      400,
    );
    assert.equal((await c("events?after=NaN")).status, 400);
  } finally {
    db.close();
  }
});
test("join quota cannot be bypassed by reconnecting; reported model budget enforced", async () => {
  const db = database();
  try {
    const { call, s } = await connected(db);
    assert.equal(
      (
        await call(
          "paint",
          paint({ usage: { input: 8001, output: 0 } }),
          s.token,
        )
      ).status,
      402,
    );
    for (let i = 0; i < 23; i++)
      assert.equal((await call("pair", setup)).status, 201);
    assert.equal((await call("pair", setup)).status, 429);
  } finally {
    db.close();
  }
});
test("presence is explicit and cannot extend the hard session expiry", async () => {
  const db = database();
  try {
    const { call, s } = await connected(db);
    const before = (await call("me", undefined, s.token)).expires;
    assert.equal((await call("heartbeat", {}, s.token)).status, 200);
    assert.equal((await call("me", undefined, s.token)).expires, before);
    db.sqlite.exec("UPDATE sessions SET expires=0");
    assert.equal((await call("heartbeat", {}, s.token)).status, 401);
  } finally {
    db.close();
  }
});
test("identical simultaneous commands return the original success rather than a storage error", async () => {
  const db = database();
  try {
    const { call, s } = await connected(db),
      b = paint();
    const r = await Promise.all([
      call("paint", b, s.token),
      call("paint", b, s.token),
    ]);
    assert.deepEqual(
      r.map((x) => x.status),
      [200, 200],
    );
    assert.equal(r[0].seq, r[1].seq);
  } finally {
    db.close();
  }
});
