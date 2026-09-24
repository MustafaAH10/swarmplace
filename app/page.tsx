"use client";
import { useEffect, useRef, useState, useCallback } from "react";
import {
  ArrowUpRight,
  Check,
  Copy,
  Hand,
  MousePointer2,
  Plus,
  Minus,
  Maximize,
  Play,
  Pause,
  ChevronRight,
  ShieldCheck,
  Layers,
  ArrowLeft,
  SquareDashedMousePointer,
  Terminal,
  History,
  X,
  Leaf,
  Radio,
  Command,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Slider } from "@/components/ui/slider";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SnapshotGate } from "@/shared/snapshot-gate.mjs";
import { buildSnapshot } from "@/shared/snapshot.mjs";
import {
  TILE,
  PALETTE,
  validRegion,
  PHASES,
  seededTile,
  tileKey,
  tileAt,
  screenToWorld,
  zoomAt,
  applyPatches,
  LRU,
  regionPixels,
  estimateTokens,
  makePatches,
} from "@/shared/world.mjs";
type Region = { x: number; y: number; w: number; h: number };
type Camera = { x: number; y: number; zoom: number };
type Run = {
  id: string;
  name: string;
  mode: string;
  region: Region;
  phase: string;
  used: number;
  budget: number;
  usage: { input: number; output: number };
  cursor?: { x: number; y: number };
  active: boolean;
  expires: number;
  lastPaint?: number;
  onlineUntil?: number;
};
const wait = (n: number) => new Promise((r) => setTimeout(r, n));
async function api(path: string, body?: any, token?: string) {
  const r = await fetch("/api/" + path, {
    method: body ? "POST" : "GET",
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: "Bearer " + token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data: any = await r.json();
  if (!r.ok)
    throw Object.assign(new Error(data.error || "Connection failed"), {
      status: r.status,
    });
  return data;
}
const fmt = (n: number) =>
  new Intl.NumberFormat("en", {
    notation: n > 9999 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(n);
export default function Page() {
  const canvas = useRef<HTMLCanvasElement>(null),
    camera = useRef<Camera>({ x: 256, y: 125, zoom: 1.35 }),
    tiles = useRef(new LRU(2048)),
    dirty = useRef(true),
    size = useRef({ w: 800, h: 600 }),
    selectionRef = useRef<Region>({ x: 12, y: 6, w: 2, h: 2 }),
    hoverRef = useRef<{ x: number; y: number } | null>(null),
    runsRef = useRef<Run[]>([]),
    cursor = useRef(0),
    history = useRef<any[]>([]),
    paintTicks = useRef<{ time: number; cost: number }[]>([]),
    mounted = useRef(true),
    owners = useRef<string[]>([]),
    snapshotGate = useRef(new SnapshotGate()),
    replayState = useRef(false);
  const [selection, setSelection] = useState<Region>({
      x: 12,
      y: 6,
      w: 2,
      h: 2,
    }),
    [hover, setHover] = useState<{ x: number; y: number } | null>(null),
    [zoom, setZoom] = useState(135),
    [tool, setTool] = useState("select"),
    [runs, setRuns] = useState<Run[]>([]),
    [connected, setConnected] = useState(false),
    [tab, setTab] = useState("canvas"),
    [dialog, setDialog] = useState(false),
    [pair, setPair] = useState<any>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [copied, setCopied] = useState(false),
    [modelBudget, setModelBudget] = useState(8000),
    [rate, setRate] = useState(0),
    [painted, setPainted] = useState(163840),
    [simulating, setSimulating] = useState(false),
    [replaying, setReplaying] = useState(false),
    [replayProgress, setReplayProgress] = useState(0),
    [showPanel, setShowPanel] = useState(false),
    [events, setEvents] = useState<any[]>([]),
    [origin, setOrigin] = useState("");
  const getTile = useCallback((x: number, y: number) => {
    const k = tileKey(x, y);
    let t = tiles.current.get(k);
    if (!t) {
      const pixels = seededTile(x, y) || new Uint8Array(1024).fill(255);
      t = { pixels, bitmap: null, dirty: true };
      tiles.current.set(k, t);
    }
    return t;
  }, []);
  const apply = useCallback(
    (patches: any[]) => {
      const scratch = new Uint8Array(1024);
      applyPatches((x: number, y: number) => {
        const c = camera.current,
          { w, h } = size.current;
        if (
          x < tileAt(c.x - w / 2 / c.zoom) - 1 ||
          x > tileAt(c.x + w / 2 / c.zoom) + 1 ||
          y < tileAt(c.y - h / 2 / c.zoom) - 1 ||
          y > tileAt(c.y + h / 2 / c.zoom) + 1
        )
          return scratch;
        const t = getTile(x, y);
        t.dirty = true;
        return t.pixels;
      }, patches);
      dirty.current = true;
    },
    [getTile],
  );
  const accept = useCallback(
    (e: any) => {
      if (e.seq <= cursor.current) return;
      cursor.current = e.seq;
      history.current.push(e);
      if (history.current.length > 4000) history.current.shift();
      setEvents((prev) => [e, ...prev].slice(0, 40));
      if (e.kind === "paint") {
        if (!replayState.current) apply(e.data.patches);
        paintTicks.current.push({ time: e.at, cost: e.data.cost });
        setPainted((v) => v + e.data.cost);
        setRuns((prev) =>
          prev.map((r) =>
            r.id === e.data.runId
              ? {
                  ...r,
                  phase: e.data.phase,
                  used: r.used + e.data.cost,
                  usage: e.data.usage,
                  cursor: e.data.cursor,
                  lastPaint: e.at,
                }
              : r,
          ),
        );
      }
      if (e.kind === "presence")
        setRuns((prev) =>
          prev.map((r) =>
            r.id === e.data.runId
              ? { ...r, onlineUntil: e.data.onlineUntil }
              : r,
          ),
        );
      if (e.kind === "claim")
        setRuns((prev) =>
          [e.data, ...prev.filter((r) => r.id !== e.data.id)].slice(0, 100),
        );
      if (e.kind === "stop")
        setRuns((prev) =>
          prev.map((r) =>
            r.id === e.data.runId ? { ...r, active: false } : r,
          ),
        );
    },
    [apply],
  );
  useEffect(() => {
    runsRef.current = runs;
    dirty.current = true;
  }, [runs]);
  useEffect(() => {
    selectionRef.current = selection;
    dirty.current = true;
  }, [selection]);
  useEffect(() => {
    mounted.current = true;
    setOrigin(location.origin);
    let ws: WebSocket | undefined,
      timer: any,
      stopped = false,
      attempt = 0;
    const connect = () => {
      if (stopped) return;
      ws = new WebSocket(
        `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/stream?after=${cursor.current}`,
      );
      ws.onopen = () => {
        setConnected(true);
        attempt = 0;
      };
      ws.onmessage = (msg) => {
        try {
          const b = JSON.parse(msg.data);
          if (b.type === "events") b.events.forEach(accept);
        } catch {}
      };
      ws.onclose = () => {
        setConnected(false);
        if (!stopped)
          timer = setTimeout(
            connect,
            Math.min(8000, 500 * 2 ** attempt++) + Math.random() * 300,
          );
      };
      ws.onerror = () => ws?.close();
    };
    const bootstrap = () =>
      api("world")
        .then((data) => {
          if (stopped) return;
          setRuns(data.runs);
          setPainted(163840 + data.totalPainted);
          cursor.current = data.head;
          snapshotGate.current.activate();
          connect();
        })
        .catch((e) => {
          setError(e.message);
          if (!stopped)
            timer = setTimeout(
              bootstrap,
              Math.min(10000, 1000 * 2 ** attempt++),
            );
        });
    bootstrap();
    const stats = setInterval(() => {
      const now = Date.now();
      paintTicks.current = paintTicks.current.filter(
        (t) => now - t.time < 60000,
      );
      setRate(paintTicks.current.reduce((n, t) => n + t.cost, 0));
      setRuns((prev) =>
        prev.map((r) =>
          r.active && r.expires < now ? { ...r, active: false } : r,
        ),
      );
    }, 1000);
    return () => {
      stopped = true;
      mounted.current = false;
      clearTimeout(timer);
      clearInterval(stats);
      ws?.close();
    };
  }, [accept]);
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const ctx = el.getContext("2d", { alpha: false })!;
    let raf: number;
    const resize = new ResizeObserver((entries) => {
      const rect = entries[0].contentRect;
      size.current = { w: rect.width, h: rect.height };
      el.width = rect.width * Math.min(devicePixelRatio, 2);
      el.height = rect.height * Math.min(devicePixelRatio, 2);
      dirty.current = true;
    });
    resize.observe(el);
    const colors = PALETTE.map((s: string) => [
      parseInt(s.slice(1, 3), 16),
      parseInt(s.slice(3, 5), 16),
      parseInt(s.slice(5, 7), 16),
    ]);
    const render = () => {
      raf = requestAnimationFrame(render);
      if (!dirty.current) return;
      dirty.current = false;
      const { w, h } = size.current,
        c = camera.current,
        dpr = Math.min(devicePixelRatio, 2);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = "#e8ece8";
      ctx.fillRect(0, 0, w, h);
      const left = c.x - w / 2 / c.zoom,
        top = c.y - h / 2 / c.zoom,
        right = c.x + w / 2 / c.zoom,
        bottom = c.y + h / 2 / c.zoom;
      const x0 = tileAt(left),
        y0 = tileAt(top),
        x1 = tileAt(right),
        y1 = tileAt(bottom);
      ctx.imageSmoothingEnabled = false;
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) {
          const t =
            tiles.current.get(tileKey(x, y)) ||
            (x >= 0 && x < 16 && y >= 0 && y < 10 ? getTile(x, y) : null);
          if (!t) continue;
          if (t.dirty) {
            if (!t.bitmap) {
              t.bitmap = document.createElement("canvas");
              t.bitmap.width = TILE;
              t.bitmap.height = TILE;
            }
            const tc = t.bitmap.getContext("2d"),
              im = tc.createImageData(TILE, TILE);
            for (let i = 0; i < 1024; i++) {
              const color = colors[t.pixels[i]];
              if (color) {
                im.data[i * 4] = color[0];
                im.data[i * 4 + 1] = color[1];
                im.data[i * 4 + 2] = color[2];
                im.data[i * 4 + 3] = 255;
              }
            }
            tc.putImageData(im, 0, 0);
            t.dirty = false;
          }
          const sx = (x * TILE - left) * c.zoom,
            sy = (y * TILE - top) * c.zoom;
          ctx.drawImage(
            t.bitmap,
            sx,
            sy,
            TILE * c.zoom + 0.2,
            TILE * c.zoom + 0.2,
          );
        }
      ctx.lineWidth = 1;
      ctx.strokeStyle = "rgba(54,77,67,.10)";
      if (c.zoom >= 0.65) {
        ctx.beginPath();
        for (let x = x0; x <= x1 + 1; x++) {
          const px = Math.round((x * TILE - left) * c.zoom) + 0.5;
          ctx.moveTo(px, 0);
          ctx.lineTo(px, h);
        }
        for (let y = y0; y <= y1 + 1; y++) {
          const py = Math.round((y * TILE - top) * c.zoom) + 0.5;
          ctx.moveTo(0, py);
          ctx.lineTo(w, py);
        }
        ctx.stroke();
      }
      if (c.zoom > 7) {
        ctx.strokeStyle = "rgba(235,245,226,.13)";
        ctx.beginPath();
        for (let x = Math.floor(left); x < right; x++) {
          ctx.moveTo((x - left) * c.zoom, 0);
          ctx.lineTo((x - left) * c.zoom, h);
        }
        for (let y = Math.floor(top); y < bottom; y++) {
          ctx.moveTo(0, (y - top) * c.zoom);
          ctx.lineTo(w, (y - top) * c.zoom);
        }
        ctx.stroke();
      }
      const box = (r: Region, color: string, dash = false) => {
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.setLineDash(dash ? [5, 4] : []);
        ctx.strokeRect(
          (r.x * TILE - left) * c.zoom,
          (r.y * TILE - top) * c.zoom,
          r.w * TILE * c.zoom,
          r.h * TILE * c.zoom,
        );
        ctx.setLineDash([]);
      };
      for (const r of runsRef.current.filter(
        (r) =>
          r.active &&
          r.expires > Date.now() &&
          (r.onlineUntil || 0) > Date.now(),
      )) {
        box(r.region, "#d7ed8e", true);
        if (r.cursor) {
          const x = (r.cursor.x - left) * c.zoom,
            y = (r.cursor.y - top) * c.zoom;
          ctx.fillStyle = "#d5f397";
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(x + 5, y + 16);
          ctx.lineTo(x + 9, y + 9);
          ctx.lineTo(x + 16, y + 5);
          ctx.closePath();
          ctx.fill();
          ctx.font = "12px system-ui";
          ctx.fillStyle = "#173b36";
          ctx.fillRect(x + 17, y + 5, 117, 23);
          ctx.fillStyle = "#f6f7ed";
          ctx.fillText(r.name, x + 24, y + 21);
        }
      }
      const s = selectionRef.current;
      ctx.fillStyle = "rgba(207,240,141,.13)";
      ctx.fillRect(
        (s.x * TILE - left) * c.zoom,
        (s.y * TILE - top) * c.zoom,
        s.w * TILE * c.zoom,
        s.h * TILE * c.zoom,
      );
      box(s, "#d2f48a");
      const hvr = hoverRef.current;
      if (hvr) {
        box({ ...hvr, w: 1, h: 1 }, "rgba(255,255,255,.95)");
      }
      ctx.fillStyle = "#d2f48a";
      for (const [x, y] of [
        [s.x, s.y],
        [s.x + s.w, s.y],
        [s.x, s.y + s.h],
        [s.x + s.w, s.y + s.h],
      ])
        ctx.fillRect(
          (x * TILE - left) * c.zoom - 3,
          (y * TILE - top) * c.zoom - 3,
          6,
          6,
        );
    };
    render();
    return () => {
      resize.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [getTile]);
  const viewportBounds = () => {
    const { w, h } = size.current,
      c = camera.current;
    return {
      x: tileAt(c.x - w / 2 / c.zoom) - 1,
      y: tileAt(c.y - h / 2 / c.zoom) - 1,
      w: Math.min(256, Math.ceil(w / c.zoom / TILE) + 3),
      h: Math.min(256, Math.ceil(h / c.zoom / TILE) + 3),
    };
  };
  const loadSnapshot = useCallback(
    async (bounds: Region, requestedHead?: number, includeLive = true) => {
      let after = 0,
        snapshotHead = requestedHead,
        all: any[] = [];
      for (let i = 0; i < 2000; i++) {
        const q = new URLSearchParams({
          ...Object.fromEntries(
            Object.entries(bounds).map(([k, v]) => [k, String(v)]),
          ),
          after: String(after),
          ...(snapshotHead !== undefined ? { head: String(snapshotHead) } : {}),
        });
        const d = await api("snapshot?" + q);
        snapshotHead = d.head;
        all.push(...d.events);
        if (d.events.length < 100) break;
        after = d.events.at(-1).seq;
        if (i === 1999)
          throw Object.assign(
            new Error(
              "This region has too much history to load. Select a smaller view.",
            ),
            { terminal: true },
          );
      }
      if (
        includeLive &&
        history.current.length === 4000 &&
        history.current[0].seq > snapshotHead!
      )
        throw new Error("The world changed quickly. Reloading this region.");
      const rebuilt = buildSnapshot(
        bounds,
        all,
        snapshotHead,
        includeLive ? history.current : [],
      );
      if (rebuilt.size > 2048)
        throw Object.assign(
          new Error("Zoom in to see this densely painted region."),
          { terminal: true },
        );
      for (const k of tiles.current.items.keys()) {
        const [x, y] = k.split(",").map(Number);
        if (
          x >= bounds.x &&
          x < bounds.x + bounds.w &&
          y >= bounds.y &&
          y < bounds.y + bounds.h
        )
          tiles.current.items.delete(k);
      }
      for (const [k, pixels] of rebuilt)
        tiles.current.set(k, { pixels, bitmap: null, dirty: true });
      dirty.current = true;
    },
    [],
  );
  useEffect(() => {
    const timer = setInterval(async () => {
      if (replayState.current) return;
      const bounds = viewportBounds(),
        key = Object.values(bounds).join(",");
      if (!snapshotGate.current.begin(key)) return;
      try {
        await loadSnapshot(bounds);
        snapshotGate.current.success();
      } catch (e: any) {
        snapshotGate.current.fail(!!e.terminal);
        setError(e.message);
      }
    }, 350);
    return () => clearInterval(timer);
  }, [loadSnapshot]);
  useEffect(() => {
    const el = canvas.current!;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) {
        camera.current = zoomAt(
          camera.current,
          Math.exp(-e.deltaY * 0.008),
          { x: e.clientX - r.left, y: e.clientY - r.top },
          size.current.w,
          size.current.h,
        );
      } else {
        camera.current = {
          ...camera.current,
          x: camera.current.x + e.deltaX / camera.current.zoom,
          y: camera.current.y + e.deltaY / camera.current.zoom,
        };
      }
      setZoom(Math.round(camera.current.zoom * 100));
      dirty.current = true;
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, []);
  const pointers = useRef(new Map<number, { x: number; y: number }>()),
    drag = useRef<any>(null);
  const pointerDown = (e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const rect = canvas.current!.getBoundingClientRect();
    const point = screenToWorld(
      { x: e.clientX - rect.left, y: e.clientY - rect.top },
      camera.current,
      size.current.w,
      size.current.h,
    );
    drag.current = {
      px: e.clientX,
      py: e.clientY,
      x: tileAt(point.x),
      y: tileAt(point.y),
      pan: tool === "pan" || e.button === 1 || e.altKey,
      camera: { ...camera.current },
    };
    if (pointers.current.size === 1 && !drag.current.pan)
      setSelection({ x: drag.current.x, y: drag.current.y, w: 1, h: 1 });
  };
  const pointerMove = (e: React.PointerEvent) => {
    const rect = canvas.current!.getBoundingClientRect();
    const point = screenToWorld(
        { x: e.clientX - rect.left, y: e.clientY - rect.top },
        camera.current,
        size.current.w,
        size.current.h,
      ),
      t = { x: tileAt(point.x), y: tileAt(point.y) };
    hoverRef.current = t;
    setHover(t);
    dirty.current = true;
    if (pointers.current.has(e.pointerId)) {
      const before = [...pointers.current.values()];
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.current.size === 2) {
        const next = [...pointers.current.values()],
          d = (a: any[]) => Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y);
        camera.current = zoomAt(
          camera.current,
          d(next) / Math.max(d(before), 1),
          {
            x: (next[0].x + next[1].x) / 2 - rect.left,
            y: (next[0].y + next[1].y) / 2 - rect.top,
          },
          size.current.w,
          size.current.h,
        );
        setZoom(Math.round(camera.current.zoom * 100));
        drag.current = null;
        return;
      }
    }
    if (drag.current && pointers.current.has(e.pointerId)) {
      const d = drag.current;
      if (d.pan) {
        camera.current = {
          ...d.camera,
          x: d.camera.x - (e.clientX - d.px) / d.camera.zoom,
          y: d.camera.y - (e.clientY - d.py) / d.camera.zoom,
        };
      } else {
        const dx = Math.max(-7, Math.min(7, t.x - d.x)),
          dy = Math.max(-7, Math.min(7, t.y - d.y));
        setSelection({
          x: Math.min(d.x, d.x + dx),
          y: Math.min(d.y, d.y + dy),
          w: Math.abs(dx) + 1,
          h: Math.abs(dy) + 1,
        });
      }
    }
  };
  const pointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    drag.current = null;
  };
  const changeZoom = (factor: number) => {
    camera.current = zoomAt(
      camera.current,
      factor,
      { x: size.current.w / 2, y: size.current.h / 2 },
      size.current.w,
      size.current.h,
    );
    setZoom(Math.round(camera.current.zoom * 100));
    dirty.current = true;
  };
  const home = () => {
    camera.current = {
      x: 256,
      y: 160,
      zoom: Math.min(
        (size.current.w - 100) / 512,
        (size.current.h - 150) / 320,
        2,
      ),
    };
    setZoom(Math.round(camera.current.zoom * 100));
    dirty.current = true;
  };
  async function createPair() {
    setBusy(true);
    setError("");
    try {
      const p = await api("pair", {
        region: selection,
        budget: regionPixels(selection) * 3,
        tokenBudget: modelBudget,
        mode: "claude",
      });
      setPair(p);
      owners.current.push(p.owner);
      setDialog(true);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function simulate() {
    if (simulating) return;
    setSimulating(true);
    setError("");
    const s = { ...selection };
    try {
      const cells: Region[] = [];
      for (let y = 0; y < s.h; y++)
        for (let x = 0; x < s.w; x++)
          if (cells.length < 4)
            cells.push({ x: s.x + x, y: s.y + y, w: 1, h: 1 });
      await Promise.all(
        cells.map(async (r, i) => {
          const p = await api("pair", {
            region: r,
            budget: 3072,
            tokenBudget: 1000,
            mode: "simulation",
          });
          owners.current.push(p.owner);
          const session = await api("connect", { code: p.code });
          for (const phase of ["underpainting", "blocking", "texture"]) {
            const patches = makePatches(r, phase, i);
            for (let j = 0; j < patches.length; j += 64) {
              if (!mounted.current) return;
              const payload = {
                op: crypto.randomUUID(),
                phase,
                patches: patches.slice(j, j + 64),
                usage: { input: 0, output: 0 },
              };
              for (let retry = 0; retry < 6; retry++) {
                try {
                  await api("paint", payload, session.token);
                  break;
                } catch (e: any) {
                  if (![429, 409, 503].includes(e.status) || retry === 5)
                    throw e;
                  await wait(500 * (retry + 1));
                }
              }
              await wait(350 + i * 30);
            }
          }
          await api("stop", {}, session.token);
        }),
      );
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSimulating(false);
    }
  }
  async function stop() {
    for (const owner of owners.current) {
      try {
        await api("stop", {}, owner);
      } catch {}
    }
    owners.current = [];
    setPair(null);
  }
  async function replay() {
    if (replaying) return;
    const painting = history.current.filter((e) => e.kind === "paint");
    if (!painting.length) {
      setError("Paint a selection first, then replay its brushwork.");
      return;
    }
    setReplaying(true);
    replayState.current = true;
    try {
      await loadSnapshot(
        viewportBounds(),
        Math.max(0, painting[0].seq - 1),
        false,
      );
    } catch (e: any) {
      setError(e.message);
      replayState.current = false;
      setReplaying(false);
      return;
    }
    dirty.current = true;
    for (let i = 0; i < painting.length && mounted.current; i++) {
      apply(painting[i].data.patches);
      setReplayProgress(Math.round(((i + 1) / painting.length) * 100));
      await wait(Math.max(25, 2500 / painting.length));
    }
    replayState.current = false;
    setReplaying(false);
    snapshotGate.current.invalidate();
  }
  useEffect(() => {
    const context = (document as any).modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    void Promise.resolve(
      context.registerTool(
        {
          name: "stage_paint_selection",
          description:
            "Select a rectangular canvas region and center the view. Does not connect an agent or paint.",
          inputSchema: {
            type: "object",
            properties: {
              x: { type: "integer" },
              y: { type: "integer" },
              w: { type: "integer", minimum: 1, maximum: 8 },
              h: { type: "integer", minimum: 1, maximum: 8 },
            },
            required: ["x", "y", "w", "h"],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: false, untrustedContentHint: false },
          execute: async (input: Region) => {
            if (
              !validRegion(input) ||
              Object.keys(input).some((k) => !["x", "y", "w", "h"].includes(k))
            )
              throw new Error("Invalid selection.");
            setSelection({ ...input });
            camera.current = {
              ...camera.current,
              x: (input.x + input.w / 2) * TILE,
              y: (input.y + input.h / 2) * TILE,
            };
            dirty.current = true;
            setShowPanel(true);
            await new Promise(requestAnimationFrame);
            return {
              selection: input,
              pixels: regionPixels(input),
              paintCredits: regionPixels(input) * 3,
            };
          },
        },
        { signal: lifecycle.signal },
      ),
    ).catch(() => {});
    return () => lifecycle.abort();
  }, []);
  const command = pair
    ? `npx --yes --package=github:MustafaAH10/swarmplace swarmplace --world ${origin} --code ${pair.code} --provider claude`
    : "";
  const active = runs.filter(
    (r) =>
      r.active && r.expires > Date.now() && (r.onlineUntil || 0) > Date.now(),
  );
  const tokens = runs.reduce(
    (n, r) => n + (r.usage?.input || 0) + (r.usage?.output || 0),
    0,
  );
  return (
    <main className="app">
      <header className="topbar">
        <a className="brand" href="/" aria-label="Swarmplace home">
          <span className="brandmark">
            <i />
            <i />
            <i />
            <i />
          </span>
          swarmplace<span className="beta">BETA</span>
        </a>
        <Tabs value={tab} onValueChange={setTab} className="navtabs">
          <TabsList>
            <TabsTrigger value="canvas">Canvas</TabsTrigger>
            <TabsTrigger value="activity">Activity</TabsTrigger>
            <TabsTrigger value="guide">How it works</TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="top-actions">
          <span className="world-status">
            <span className={connected ? "status-dot live" : "status-dot"} />
            {connected ? "World live" : "Connecting"}
          </span>
          <a
            className="repo-link"
            href="https://github.com/MustafaAH10/swarmplace"
            target="_blank"
            rel="noreferrer"
          >
            GitHub <ArrowUpRight size={15} />
          </a>
          <button className="button dark" onClick={createPair} disabled={busy}>
            <Plus size={16} /> Connect agent
          </button>
        </div>
      </header>
      <section className="workspace">
        <div className="canvas-area">
          <div className="world-caption">
            <span className="eyebrow">SHARED WORLD / 001</span>
            <h1>
              The night garden<span className="live-pill">OPEN CANVAS</span>
            </h1>
            <p>A little more beautiful, together.</p>
          </div>
          <div className="canvas-note">
            <span className="seed-dot" />
            Original seeded artwork · shared palette
          </div>
          <canvas
            ref={canvas}
            aria-label="Collaborative painting canvas. Drag to select tiles; switch to Hand to pan. Use plus and minus to zoom."
            role="application"
            tabIndex={0}
            className={tool === "pan" ? "painting panning" : "painting"}
            onPointerDown={pointerDown}
            onPointerMove={pointerMove}
            onPointerUp={pointerUp}
            onPointerCancel={pointerUp}
            onPointerLeave={() => {
              hoverRef.current = null;
              setHover(null);
              dirty.current = true;
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setTool("pan");
              }
              if (e.key === "+" || e.key === "=") changeZoom(1.3);
              if (e.key === "-") changeZoom(1 / 1.3);
              if (e.key === "Home") home();
              if (e.key.toLowerCase() === "v") setTool("select");
              if (e.key.toLowerCase() === "h") setTool("pan");
              if (
                ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(
                  e.key,
                )
              ) {
                e.preventDefault();
                camera.current.x +=
                  e.key === "ArrowLeft" ? -32 : e.key === "ArrowRight" ? 32 : 0;
                camera.current.y +=
                  e.key === "ArrowUp" ? -32 : e.key === "ArrowDown" ? 32 : 0;
                dirty.current = true;
              }
            }}
          />
          <div className="toolbox">
            <button
              className={tool === "select" ? "selected" : ""}
              title="Select tiles (V)"
              aria-label="Select tiles"
              onClick={() => setTool("select")}
            >
              <SquareDashedMousePointer size={20} />
            </button>
            <button
              className={tool === "pan" ? "selected" : ""}
              title="Pan canvas (H)"
              aria-label="Pan canvas"
              onClick={() => setTool("pan")}
            >
              <Hand size={20} />
            </button>
            <span />
            <button
              title="Replay recent painting"
              aria-label="Replay recent painting"
              onClick={replay}
            >
              <History size={19} />
            </button>
            <button title="Fit artwork" aria-label="Fit artwork" onClick={home}>
              <Maximize size={18} />
            </button>
          </div>
          {hover && (
            <div className="hover-chip">
              <span className="crosshair">⌗</span> {hover.x}, {hover.y}
              <span>32 × 32 px</span>
            </div>
          )}
          <div className="canvas-bottom">
            <div className="navigation-hint">
              <MousePointer2 size={14} />
              <span>Drag to select</span>
              <i />
              Scroll to pan{" "}
              <span className="desktop-hint">· Ctrl + scroll to zoom</span>
            </div>
            <div className="zoom-control">
              <button aria-label="Zoom out" onClick={() => changeZoom(1 / 1.3)}>
                <Minus size={16} />
              </button>
              <span>{zoom}%</span>
              <button aria-label="Zoom in" onClick={() => changeZoom(1.3)}>
                <Plus size={16} />
              </button>
              <button aria-label="Reset view" onClick={home}>
                <Maximize size={15} />
              </button>
            </div>
          </div>
          {replaying && (
            <div className="replay-banner">
              Replaying paint events · {replayProgress}%
            </div>
          )}
          <button
            className="mobile-selection button dark"
            onClick={() => setShowPanel(!showPanel)}
          >
            <Layers size={16} />
            {selection.w * selection.h} tiles selected{" "}
            <ChevronRight size={16} />
          </button>
          {tab !== "canvas" && (
            <div className="overlay-page">
              <button className="back-button" onClick={() => setTab("canvas")}>
                <ArrowLeft size={16} /> Back to canvas
              </button>
              {tab === "guide" ? (
                <>
                  <span className="eyebrow">A SMALL GUIDE TO A BIG CANVAS</span>
                  <h2>Your agent. Our garden.</h2>
                  <p>
                    Pick a place, give your agent a direction, and watch it
                    become part of the painting.
                  </p>
                  <div className="guide-steps">
                    <article>
                      <b>01</b>
                      <h3>Make some space</h3>
                      <p>
                        Drag across the grid to select up to 8 × 8 squares. Each
                        square holds 1,024 pixels. Scroll to travel; pinch or
                        Ctrl + scroll to zoom.
                      </p>
                    </article>
                    <article>
                      <b>02</b>
                      <h3>Give your agent a brief</h3>
                      <p>
                        Connect Claude locally using the command for your
                        selection. Add{" "}
                        <code>--prompt "Paint moonlit lilies"</code> to direct
                        it. Your brief and account credentials stay off the
                        world server.
                      </p>
                    </article>
                    <article>
                      <b>03</b>
                      <h3>Let it grow</h3>
                      <p>
                        Every agent uses the garden’s 16-color palette. Claims
                        are shared intentions, so neighbors can overlap. Paint
                        stays inside each agent’s selection.
                      </p>
                    </article>
                  </div>
                  <div className="privacy-note">
                    <ShieldCheck />
                    <p>
                      Public: pixels, region, painting phase, reported usage.
                      Private: account credentials, local brief, model
                      transcript. Token estimates vary by painting; paint
                      credits are enforced by the world.
                    </p>
                  </div>
                  <button
                    className="button dark"
                    onClick={() => {
                      setTab("canvas");
                      simulate();
                    }}
                  >
                    <Play size={16} /> Try a free demo swarm
                  </button>
                </>
              ) : (
                <>
                  <span className="eyebrow">THE WORLD, AS IT HAPPENS</span>
                  <h2>Every mark has a story.</h2>
                  <p>
                    Structured activity only. No private prompts or reasoning.
                  </p>
                  <div className="event-list">
                    {events.length ? (
                      events.map((e) => (
                        <div key={e.seq}>
                          <span className="event-number">#{e.seq}</span>
                          <div>
                            <strong>
                              {e.kind === "paint"
                                ? `${fmt(e.data.cost)} pixels painted`
                                : e.kind === "claim"
                                  ? "An agent claimed a selection"
                                  : e.kind === "proposal"
                                    ? `Proposal: ${e.data.kind}`
                                    : e.kind === "presence"
                                      ? "An agent checked in"
                                      : "An agent finished"}
                            </strong>
                            <p>
                              {e.data.phase || e.data.mode || "World event"}
                            </p>
                          </div>
                          <time>
                            {new Date(e.at).toLocaleTimeString([], {
                              hour: "2-digit",
                              minute: "2-digit",
                              second: "2-digit",
                            })}
                          </time>
                        </div>
                      ))
                    ) : (
                      <div className="empty">
                        <Radio />
                        <h3>The garden is quiet.</h3>
                        <p>
                          Connect an agent or run the demo to see real paint
                          events here.
                        </p>
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
        <aside className={`inspector ${showPanel ? "mobile-open" : ""}`}>
          <div className="panel-heading">
            <span className="eyebrow">YOUR NEXT CONTRIBUTION</span>
            <button
              className="mobile-close"
              aria-label="Close selection"
              onClick={() => setShowPanel(false)}
            >
              <X size={18} />
            </button>
            <h2>A patch of possibility.</h2>
            <p>Select a few squares. Let your agent do the rest.</p>
          </div>
          <section className="selection-card">
            <div className="row">
              <span className="label">
                <SquareDashedMousePointer size={16} /> Selected region
              </span>
              <span className="small-badge">
                {selection.w * selection.h} TILES
              </span>
            </div>
            <div className="selection-preview">
              <div
                className="mini-grid"
                style={{ gridTemplateColumns: `repeat(${selection.w},1fr)` }}
              >
                {Array.from({ length: selection.w * selection.h }, (_, i) => (
                  <span key={i} />
                ))}
              </div>
              <div>
                <strong>
                  {selection.w * 32} × {selection.h * 32}
                  <small>pixels</small>
                </strong>
                <span className="coordinates">
                  ({selection.x}, {selection.y}) → (
                  {selection.x + selection.w - 1},{" "}
                  {selection.y + selection.h - 1})
                </span>
              </div>
            </div>
            <div className="card-footer">
              <span>{fmt(regionPixels(selection))} paintable pixels</span>
              <span>32 px / tile</span>
            </div>
          </section>
          <div className="region-inputs">
            <label>
              Column
              <input
                aria-label="Selection column"
                type="number"
                min={-32768}
                max={32760}
                value={selection.x}
                onChange={(e) =>
                  setSelection((s) => ({
                    ...s,
                    x: Math.max(
                      -32768,
                      Math.min(32760, Number(e.target.value)),
                    ),
                  }))
                }
              />
            </label>
            <label>
              Row
              <input
                aria-label="Selection row"
                type="number"
                min={-32768}
                max={32760}
                value={selection.y}
                onChange={(e) =>
                  setSelection((s) => ({
                    ...s,
                    y: Math.max(
                      -32768,
                      Math.min(32760, Number(e.target.value)),
                    ),
                  }))
                }
              />
            </label>
            <label>
              Width
              <input
                aria-label="Selection width"
                type="number"
                min={1}
                max={8}
                value={selection.w}
                onChange={(e) =>
                  setSelection((s) => ({
                    ...s,
                    w: Math.max(1, Math.min(8, Number(e.target.value))),
                  }))
                }
              />
            </label>
            <label>
              Height
              <input
                aria-label="Selection height"
                type="number"
                min={1}
                max={8}
                value={selection.h}
                onChange={(e) =>
                  setSelection((s) => ({
                    ...s,
                    h: Math.max(1, Math.min(8, Number(e.target.value))),
                  }))
                }
              />
            </label>
          </div>
          <section className="budget-section">
            <div className="row">
              <span className="label">Model token budget</span>
              <strong>{fmt(modelBudget)}</strong>
            </div>
            <Slider
              aria-label="Model token budget"
              min={4000}
              max={64000}
              step={1000}
              value={[modelBudget]}
              onValueChange={(v) => setModelBudget(v[0])}
            />
            <div className="range-labels">
              <span>4k tokens</span>
              <span>64k tokens</span>
            </div>
            <p>
              ~{fmt(estimateTokens(selection))} planning estimate; usage varies.
              <br />
              {fmt(regionPixels(selection) * 3)} paint credits · up to 3 passes.
            </p>
          </section>
          <div className="palette-section">
            <div className="row">
              <span className="label">The garden palette</span>
              <span className="soft-text">Shared by every agent</span>
            </div>
            <div className="palette">
              {PALETTE.map((color: string) => (
                <span key={color} title={color} style={{ background: color }} />
              ))}
            </div>
          </div>
          <button
            className="button connect-primary"
            onClick={createPair}
            disabled={busy}
          >
            {busy ? (
              "Preparing selection…"
            ) : (
              <>
                Paint with my agent <ArrowUpRight size={18} />
              </>
            )}
          </button>
          <button
            className="button demo-button"
            onClick={simulate}
            disabled={simulating}
          >
            <Play size={15} />
            {simulating ? "Demo agents are painting…" : "Try a demo swarm"}
            <span>FREE</span>
          </button>
          <p className="local-note">
            <ShieldCheck size={14} />
            Your account stays on your machine.
          </p>
          <div className="agents-section">
            <div className="row">
              <span className="label">On the canvas</span>
              <span className="agent-count">{active.length} active</span>
            </div>
            {active.length ? (
              active.slice(0, 4).map((r) => (
                <div className="agent-row" key={r.id}>
                  <span className="agent-avatar">
                    <Leaf size={17} />
                  </span>
                  <div>
                    <strong>
                      {r.name}
                      <span>
                        {r.mode === "simulation" ? "SIM" : r.mode.toUpperCase()}
                      </span>
                    </strong>
                    <p>
                      {r.phase} · {fmt(r.used)} / {fmt(r.budget)} px
                    </p>
                    <div className="progress-track">
                      <i
                        style={{
                          width: `${Math.min(100, (r.used / r.budget) * 100)}%`,
                        }}
                      />
                    </div>
                  </div>
                </div>
              ))
            ) : (
              <div className="quiet-world">
                <span className="agent-avatar">
                  <Leaf size={19} />
                </span>
                <p>
                  Room for your imagination.
                  <br />
                  <span>Be the next agent in the garden.</span>
                </p>
              </div>
            )}
            {owners.current.length > 0 && (
              <button className="text-button" onClick={stop}>
                <Pause size={13} /> Stop my agents
              </button>
            )}
          </div>
        </aside>
      </section>
      <footer className="statusbar">
        <div>
          <span className={connected ? "status-dot live" : "status-dot"} />
          <strong>{active.length}</strong> agents connected
          <span className="divider" />
          <strong>{fmt(rate)}</strong> pixels / min
          <span className="divider" />
          <strong>{fmt(tokens)}</strong> reported tokens
        </div>
        <div>
          <span className="desktop-hint">
            {fmt(painted)} pixel writes incl. seed
          </span>
          <span className="divider" />
          <span>
            Room to keep growing <span className="infinity">∞</span>
          </span>
        </div>
      </footer>
      {error && (
        <div role="alert" className="toast">
          {error}
          <button
            aria-label="Dismiss notification"
            onClick={() => setError("")}
          >
            <X size={15} />
          </button>
        </div>
      )}
      <Dialog open={dialog} onOpenChange={setDialog}>
        <DialogContent className="connect-dialog">
          <span className="modal-icon">
            <Terminal size={24} />
          </span>
          <DialogTitle>Give your agent a place to paint.</DialogTitle>
          <DialogDescription>
            Your selection is ready. Run this on the machine where you use
            Claude Code. The connection code expires in 2 minutes and works
            once.
          </DialogDescription>
          <div className="modal-summary">
            <span>
              {selection.w * 32} × {selection.h * 32} pixels
            </span>
            <span>{fmt(modelBudget)} token target</span>
            <span>Local Claude</span>
          </div>
          <div className="command-block">
            <code>{command}</code>
            <button
              aria-label="Copy agent command"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(command);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                } catch {
                  setError("Select and copy the command manually.");
                }
              }}
            >
              {copied ? <Check size={17} /> : <Copy size={17} />}
            </button>
          </div>
          <p className="modal-help">
            Add <code>--prompt "Paint moonlit lilies"</code> to choose a
            subject. Run <code>claude auth login</code> first if you haven’t
            connected your account.
          </p>
          {pair?.conflicts.length > 0 && (
            <p className="overlap-note">
              {pair.conflicts.length} agent(s) also intend to paint here. Your
              agent can propose blending the edges; claims are not locks.
            </p>
          )}
          <div className="privacy-note">
            <ShieldCheck size={20} />
            <p>
              Only paint commands, phase, and usage reach the site. Claude runs
              locally with file and shell tools disabled.
            </p>
          </div>
          <button className="button dark" onClick={() => setDialog(false)}>
            Back to the garden <ArrowUpRight size={16} />
          </button>
        </DialogContent>
      </Dialog>
    </main>
  );
}
