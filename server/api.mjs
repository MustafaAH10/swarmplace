import {
  Fault,
  exact,
  setupInput,
  paintInput,
  token,
  digest,
} from "./protocol.mjs";
import { PALETTE, PHASES, overlaps } from "../shared/world.mjs";
const TTL = 15 * 60 * 1000;
const json = (b, status = 200) =>
  new Response(JSON.stringify(b), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
const rows = async (stmt) => (await stmt.all()).results;
export async function eventPage(db, after = 0, head = Number.MAX_SAFE_INTEGER) {
  return (
    await rows(
      db
        .prepare(
          "SELECT seq,kind,data,at FROM events WHERE seq>? AND seq<=? ORDER BY seq LIMIT 100",
        )
        .bind(after, head),
    )
  ).map((e) => ({ ...e, data: JSON.parse(e.data) }));
}
export async function publicRuns(db) {
  const list = await rows(
    db.prepare(
      "SELECT id,data,used,budget,expires,active FROM runs ORDER BY expires DESC LIMIT 100",
    ),
  );
  return list.map((r) => ({
    ...JSON.parse(r.data),
    id: r.id,
    used: r.used,
    budget: r.budget,
    expires: r.expires,
    active: !!r.active && r.expires > Date.now(),
  }));
}
export async function head(db) {
  return (
    await db.prepare("SELECT COALESCE(MAX(seq),0) AS seq FROM events").first()
  ).seq;
}
async function auth(req, db) {
  const raw = req.headers
    .get("authorization")
    ?.match(/^Bearer ([a-f0-9]{48})$/)?.[1];
  if (!raw) throw new Fault(401, "Connect a local agent first.");
  const row = await db
    .prepare(
      "SELECT r.* FROM sessions s JOIN runs r ON r.id=s.run_id WHERE s.hash=? AND s.expires>? AND r.expires>? AND r.active=1",
    )
    .bind(await digest(raw), Date.now(), Date.now())
    .first();
  if (!row) throw new Fault(401, "Session ended. Create a new connection.");
  return { ...row, info: JSON.parse(row.data) };
}
async function body(req) {
  if (!req.headers.get("content-type")?.startsWith("application/json"))
    throw new Fault(415, "JSON required.");
  if (Number(req.headers.get("content-length") || 0) > 32768)
    throw new Fault(413, "Request too large.");
  const reader = req.body?.getReader();
  let chunks = [],
    size = 0;
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 32768) {
      await reader.cancel();
      throw new Fault(413, "Request too large.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.length;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Fault(400, "Invalid JSON.");
  }
}
async function quota(db, key, max, ms) {
  const now = Date.now();
  const bucket = Math.floor(now / ms);
  const r = await db
    .prepare(
      "INSERT INTO quotas(key,count,expires) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 WHERE count<? RETURNING count",
    )
    .bind(`${key}:${bucket}`, now + ms, max)
    .first();
  if (!r) throw new Fault(429, "Please wait before trying again.");
}
export async function handleAPI(req, env) {
  const db = env.DB;
  try {
    if (!db) throw new Fault(503, "World storage is unavailable.");
    const url = new URL(req.url),
      path = url.pathname;
    let now = Date.now();
    const origin = req.headers.get("origin");
    if (origin && origin !== url.origin)
      throw new Fault(
        403,
        "This world accepts same-origin browser requests only.",
      );
    if (req.headers.get("sec-fetch-site") === "cross-site")
      throw new Fault(403, "Cross-site request rejected.");
    const ip = await digest(
      `${req.headers.get("cf-connecting-ip") || "local"}:${new Date().toISOString().slice(0, 10)}`,
    );
    if (path === "/api/health") return json({ ok: true, protocol: 1 });
    if (path === "/api/world" && req.method === "GET") {
      const [heads, runRows, stats] = await db.batch([
        db.prepare("SELECT COALESCE(MAX(seq),0) AS seq FROM events"),
        db.prepare(
          "SELECT id,data,used,budget,expires,active FROM runs ORDER BY expires DESC LIMIT 100",
        ),
        db.prepare("SELECT COALESCE(SUM(used),0) AS total FROM runs"),
      ]);
      return json({
        head: heads.results[0].seq,
        totalPainted: stats.results[0].total,
        runs: runRows.results.map((r) => ({
          ...JSON.parse(r.data),
          id: r.id,
          used: r.used,
          budget: r.budget,
          expires: r.expires,
          active: !!r.active && r.expires > Date.now(),
        })),
        palette: PALETTE,
        phases: PHASES,
        theme: "The night garden",
        seed: "night-garden-v1",
        tileSize: 32,
      });
    }
    if (path === "/api/events" && req.method === "GET") {
      const a = Number(url.searchParams.get("after") || 0);
      if (!Number.isSafeInteger(a) || a < 0)
        throw new Fault(400, "Invalid event cursor.");
      return json({ events: await eventPage(db, a), head: await head(db) });
    }
    if (path === "/api/history" && req.method === "GET") {
      const before = Number(
        url.searchParams.get("before") ?? Number.MAX_SAFE_INTEGER,
      );
      if (!Number.isSafeInteger(before) || before < 1)
        throw new Fault(400, "Invalid history cursor.");
      const found = await rows(
        db
          .prepare(
            "SELECT seq,kind,data,at FROM events WHERE seq<? ORDER BY seq DESC LIMIT 41",
          )
          .bind(before),
      );
      const events = found
        .slice(0, 40)
        .map((e) => ({ ...e, data: JSON.parse(e.data) }));
      return json({
        events,
        before: found.length > 40 ? events.at(-1).seq : null,
      });
    }
    if (path === "/api/snapshot" && req.method === "GET") {
      const r = {
        x: Number(url.searchParams.get("x")),
        y: Number(url.searchParams.get("y")),
        w: Number(url.searchParams.get("w")),
        h: Number(url.searchParams.get("h")),
      };
      if (
        !Object.values(r).every(Number.isSafeInteger) ||
        r.w < 1 ||
        r.h < 1 ||
        r.w > 256 ||
        r.h > 256
      )
        throw new Fault(400, "Invalid viewport.");
      const seq = Number(url.searchParams.get("head") || (await head(db))),
        after = Number(url.searchParams.get("after") || 0);
      if (
        !Number.isSafeInteger(seq) ||
        !Number.isSafeInteger(after) ||
        seq < 0 ||
        after < 0
      )
        throw new Fault(400, "Invalid cursor.");
      const events = await rows(
        db
          .prepare(
            "SELECT seq,kind,data,at FROM events WHERE kind='paint' AND seq>? AND seq<=? AND x<? AND x+w>? AND y<? AND y+h>? ORDER BY seq LIMIT 100",
          )
          .bind(after, seq, r.x + r.w, r.x, r.y + r.h, r.y),
      );
      return json({
        head: seq,
        events: events.map((e) => ({ ...e, data: JSON.parse(e.data) })),
      });
    }
    if (path === "/api/pair" && req.method === "POST") {
      await quota(db, `join:${ip}`, 24, 3600000);
      await quota(db, "world-joins", 1000, 3600000);
      const b = setupInput(await body(req));
      now = Date.now();
      const id = crypto.randomUUID(),
        code = token(),
        owner = token();
      const info = {
        id,
        name: `${b.mode === "claude" ? "Claude" : b.mode === "replay" ? "Replay" : "Studio"} · ${id.slice(0, 4)}`,
        mode: b.mode,
        region: b.region,
        tokenBudget: b.tokenBudget,
        phase: "underpainting",
        onlineUntil: 0,
        usage: { input: 0, output: 0 },
        created: now,
      };
      const conflicts = (await publicRuns(db))
        .filter((r) => r.active && overlaps(r.region, b.region))
        .map((r) => r.id);
      await db.batch([
        db
          .prepare("INSERT INTO runs(id,data,budget,expires) VALUES(?,?,?,?)")
          .bind(id, JSON.stringify(info), b.budget, now + TTL),
        db
          .prepare("INSERT INTO pairs(hash,run_id,expires) VALUES(?,?,?)")
          .bind(await digest(code), id, now + 120000),
        db
          .prepare("INSERT INTO sessions(hash,run_id,expires) VALUES(?,?,?)")
          .bind(await digest(owner), id, now + TTL),
        db.prepare("INSERT INTO events(kind,data,at) VALUES(?,?,?)").bind(
          "claim",
          JSON.stringify({
            ...info,
            budget: b.budget,
            used: 0,
            expires: now + TTL,
            active: true,
          }),
          now,
        ),
      ]);
      return json(
        { code, owner, run: info, expires: now + 120000, conflicts },
        201,
      );
    }
    if (path === "/api/connect" && req.method === "POST") {
      await quota(db, `connect:${ip}`, 60, 60000);
      const b = await body(req);
      now = Date.now();
      exact(b, ["code"]);
      if (typeof b.code !== "string" || !/^[a-f0-9]{48}$/.test(b.code))
        throw new Fault(400, "Invalid pairing code.");
      const h = await digest(b.code),
        raw = token(),
        receipt = token();
      const p = await db
        .prepare(
          "SELECT * FROM pairs WHERE hash=? AND redeemed=0 AND expires>?",
        )
        .bind(h, now)
        .first();
      if (!p) throw new Fault(401, "Pairing code expired or already used.");
      await db.batch([
        db
          .prepare(
            "UPDATE pairs SET redeemed=1,receipt=? WHERE hash=? AND redeemed=0 AND expires>?",
          )
          .bind(receipt, h, now),
        db
          .prepare(
            "INSERT INTO sessions(hash,run_id,expires) SELECT ?,run_id,? FROM pairs WHERE hash=? AND receipt=?",
          )
          .bind(await digest(raw), now + TTL, h, receipt),
      ]);
      if (
        !(await db
          .prepare("SELECT hash FROM sessions WHERE hash=?")
          .bind(await digest(raw))
          .first())
      )
        throw new Fault(409, "Pairing code was already claimed.");
      const onlineUntil = Date.now() + 60000;
      await db.batch([
        db
          .prepare(
            "UPDATE runs SET data=json_set(data,'$.onlineUntil',?) WHERE id=?",
          )
          .bind(onlineUntil, p.run_id),
        db
          .prepare("INSERT INTO events(kind,data,at) VALUES(?,?,?)")
          .bind(
            "presence",
            JSON.stringify({ runId: p.run_id, onlineUntil }),
            Date.now(),
          ),
      ]);
      const r = await db
        .prepare("SELECT data,budget FROM runs WHERE id=?")
        .bind(p.run_id)
        .first();
      return json({
        token: raw,
        expires: now + TTL,
        run: JSON.parse(r.data),
        budget: r.budget,
        palette: PALETTE,
        phases: PHASES,
      });
    }
    if (path === "/api/heartbeat" && req.method === "POST") {
      const r = await auth(req, db);
      await quota(db, `heartbeat:${r.id}`, 6, 60000);
      const onlineUntil = Date.now() + 60000;
      await db.batch([
        db
          .prepare(
            "UPDATE runs SET data=json_set(data,'$.onlineUntil',?) WHERE id=?",
          )
          .bind(onlineUntil, r.id),
        db
          .prepare("INSERT INTO events(kind,data,at) VALUES(?,?,?)")
          .bind(
            "presence",
            JSON.stringify({ runId: r.id, onlineUntil }),
            Date.now(),
          ),
      ]);
      return json({ onlineUntil });
    }
    if (path === "/api/me" && req.method === "GET") {
      const r = await auth(req, db);
      return json({
        ...r.info,
        used: r.used,
        budget: r.budget,
        expires: r.expires,
      });
    }
    if (path === "/api/paint" && req.method === "POST") {
      const b = await body(req);
      now = Date.now();
      const r = await auth(req, db),
        cost = paintInput(b, r.info);
      const op = `${r.id}:${b.op}`;
      const old = await db
        .prepare("SELECT seq FROM events WHERE op=?")
        .bind(op)
        .first();
      if (old) return json({ seq: old.seq, duplicate: true });
      if (r.next_write > now)
        throw new Fault(429, "Painting too quickly. Retry shortly.");
      if (r.used + cost > r.budget)
        throw new Fault(402, "Paint budget exhausted.");
      const usage = b.usage || r.info.usage;
      if (
        usage.input < r.info.usage.input ||
        usage.output < r.info.usage.output
      )
        throw new Fault(400, "Usage counters cannot decrease.");
      if (usage.input + usage.output > r.info.tokenBudget)
        throw new Fault(402, "Reported model token budget exceeded.");
      await quota(db, `paint:${ip}`, 1000, 60000);
      const info = {
        ...r.info,
        phase: b.phase,
        usage,
        cursor: { x: b.patches.at(-1).x, y: b.patches.at(-1).y },
        lastPaint: now,
      };
      const data = {
        runId: r.id,
        phase: b.phase,
        patches: b.patches,
        cost,
        usage,
        cursor: info.cursor,
      };
      const region = r.info.region;
      await db.batch([
        db
          .prepare(
            "UPDATE runs SET used=used+?,revision=revision+1,next_write=?,data=json_set(?,'$.onlineUntil',json_extract(data,'$.onlineUntil')),last_op=? WHERE id=? AND revision=? AND used+?<=budget AND active=1 AND expires>?",
          )
          .bind(
            cost,
            now + 200,
            JSON.stringify(info),
            op,
            r.id,
            r.revision,
            cost,
            now,
          ),
        db
          .prepare(
            "INSERT OR IGNORE INTO events(kind,data,at,op,x,y,w,h) SELECT 'paint',?,?,?,?,?,?,? FROM runs WHERE id=? AND last_op=? AND revision=?",
          )
          .bind(
            JSON.stringify(data),
            now,
            op,
            region.x,
            region.y,
            region.w,
            region.h,
            r.id,
            op,
            r.revision + 1,
          ),
      ]);
      const e = await db
        .prepare("SELECT seq FROM events WHERE op=?")
        .bind(op)
        .first();
      if (!e) throw new Fault(409, "Concurrent update; retry this operation.");
      return json({ seq: e.seq, used: r.used + cost, budget: r.budget });
    }
    if (path === "/api/proposal" && req.method === "POST") {
      const r = await auth(req, db),
        b = await body(req);
      exact(b, ["target", "kind"]);
      if (
        !["blend-edge", "share-palette", "yield-region"].includes(b.kind) ||
        typeof b.target !== "string" ||
        b.target.length > 64
      )
        throw new Fault(400, "Choose a supported coordination proposal.");
      if (
        !(await db
          .prepare("SELECT id FROM runs WHERE id=?")
          .bind(b.target)
          .first())
      )
        throw new Fault(404, "Agent not found.");
      await quota(db, `proposal:${r.id}`, 5, 60000);
      await db
        .prepare("INSERT INTO events(kind,data,at) VALUES(?,?,?)")
        .bind(
          "proposal",
          JSON.stringify({ runId: r.id, target: b.target, kind: b.kind }),
          now,
        )
        .run();
      return json({ ok: true });
    }
    if (path === "/api/stop" && req.method === "POST") {
      const r = await auth(req, db);
      await db.batch([
        db.prepare("UPDATE runs SET active=0 WHERE id=?").bind(r.id),
        db.prepare("DELETE FROM sessions WHERE run_id=?").bind(r.id),
        db
          .prepare("INSERT INTO events(kind,data,at) VALUES(?,?,?)")
          .bind("stop", JSON.stringify({ runId: r.id }), now),
      ]);
      return json({ ok: true });
    }
    throw new Fault(404, "Unknown world endpoint.");
  } catch (e) {
    return json(
      {
        error:
          e instanceof Fault
            ? e.message
            : "The world is temporarily unavailable. Please retry.",
      },
      e instanceof Fault ? e.status : 503,
    );
  }
}
