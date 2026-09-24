import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { makePatches, applyPatches, LRU } from "../shared/world.mjs";
const { values: a } = parseArgs({
  options: {
    agents: { type: "string", default: "16" },
    world: { type: "string" },
    "in-process": { type: "boolean" },
  },
});
const count = Number(a.agents);
if (!Number.isInteger(count) || count < 1 || count > 128)
  throw new Error("Choose 1–128 agents.");
if (!a["in-process"] && !a.world)
  throw new Error("Use --in-process or --world URL.");
if (!a["in-process"] && count > 16)
  throw new Error(
    "Public live stress is limited to 16 agents per run. Use --in-process for 128 agents.",
  );
let db, handler;
if (a["in-process"]) {
  const { database } = await import("../tests/db.mjs");
  db = database();
  handler = (await import("../server/api.mjs")).handleAPI;
}
const started = performance.now();
let writes = 0,
  pixels = 0,
  retries = 0;
const latencies = [];
const pause = (n) => new Promise((r) => setTimeout(r, n));
const call = async (path, body, token, i, attempt = 0) => {
  const req = new Request(
    new URL("/api/" + path, a.world || "https://test.invalid"),
    {
      method: body ? "POST" : "GET",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: "Bearer " + token } : {}),
        ...(a["in-process"] ? { "cf-connecting-ip": `test-${i}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    },
  );
  const start = performance.now(),
    res = handler ? await handler(req, { DB: db }) : await fetch(req);
  latencies.push(performance.now() - start);
  const json = await res.json();
  if (!res.ok) {
    if ([429, 409, 503].includes(res.status) && attempt < 6) {
      retries++;
      await pause(250 * (attempt + 1));
      return call(path, body, token, i, attempt + 1);
    }
    throw new Error(json.error);
  }
  return json;
};
try {
  await Promise.all(
    Array.from({ length: count }, async (_, i) => {
      const region = { x: 20 + (i % 16), y: Math.floor(i / 16), w: 1, h: 1 };
      const p = await call(
          "pair",
          { region, budget: 1024, tokenBudget: 1000, mode: "simulation" },
          null,
          i,
        ),
        s = await call("connect", { code: p.code }, null, i);
      const patches = makePatches(region, "texture");
      for (let j = 0; j < patches.length; j += 128) {
        await call(
          "paint",
          {
            op: randomUUID(),
            phase: "texture",
            patches: patches.slice(j, j + 128),
            usage: { input: 0, output: 0 },
          },
          s.token,
          i,
        );
        writes++;
        pixels += patches.slice(j, j + 128).reduce((n, p) => n + p.w * p.h, 0);
        await pause(210);
      }
      await call("stop", {}, s.token, i);
    }),
  );
  latencies.sort((a, b) => a - b);
  console.log(
    JSON.stringify(
      {
        agents: count,
        writes,
        pixels,
        retries,
        durationMs: Math.round(performance.now() - started),
        requestP95Ms: Math.round(
          latencies[Math.floor(latencies.length * 0.95)],
        ),
        mode: handler ? "in-process SQLite protocol" : "live world",
      },
      null,
      2,
    ),
  );
} finally {
  db?.close();
}
