import assert from "node:assert/strict";
import WebSocket from "ws";
import { randomUUID } from "node:crypto";
const world = new URL(process.argv[2] || "http://localhost:5173");
const call = async (path, body, token) => {
  const r = await fetch(new URL("/api/" + path, world), {
    method: body ? "POST" : "GET",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: "Bearer " + token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const b = await r.json();
  assert.ok(r.ok, b.error);
  return b;
};
const initial = await call("world");
let seen = [],
  socket;
const connect = async (after) => {
  const u = new URL("/api/stream", world);
  u.protocol = world.protocol === "https:" ? "wss:" : "ws:";
  u.searchParams.set("after", String(after));
  socket = new WebSocket(u, { origin: world.origin });
  socket.on("message", (data) => {
    const b = JSON.parse(data.toString());
    if (b.type === "events") seen.push(...b.events);
  });
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
};
const until = async (fn) => {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > 12000) throw new Error("WebSocket event timeout.");
    await new Promise((r) => setTimeout(r, 100));
  }
};
let s;
try {
  await connect(initial.head);
  const p = await call("pair", {
    region: { x: 15, y: 8, w: 1, h: 1 },
    budget: 2048,
    tokenBudget: 1000,
    mode: "simulation",
  });
  s = await call("connect", { code: p.code });
  const first = await call(
    "paint",
    {
      op: randomUUID(),
      phase: "color",
      patches: [{ x: 480, y: 256, w: 32, h: 32, c: 3 }],
      usage: { input: 0, output: 0 },
    },
    s.token,
  );
  await until(() => seen.some((e) => e.seq === first.seq));
  socket.close();
  await new Promise((r) => setTimeout(r, 250));
  const second = await call(
    "paint",
    {
      op: randomUUID(),
      phase: "accents",
      patches: [{ x: 492, y: 266, w: 6, h: 6, c: 7 }],
      usage: { input: 0, output: 0 },
    },
    s.token,
  );
  seen = [];
  await connect(first.seq);
  await until(() => seen.some((e) => e.seq === second.seq));
  assert.ok(seen.every((e) => e.seq > first.seq));
  const snapshot = await call("snapshot?x=15&y=8&w=1&h=1");
  assert.ok(snapshot.events.some((e) => e.seq === second.seq));
  console.log(
    "PASS: real WebSocket paint, disconnect/resume, ordered cursor and durable snapshot.",
  );
} finally {
  socket?.close();
  if (s) await call("stop", {}, s.token);
}
