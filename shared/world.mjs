export const TILE = 32;
export const LIMIT = 32768; // Tile coordinates: a 2,097,152px-wide virtual world.
export const PALETTE = [
  "#132f3b",
  "#1c4852",
  "#28626a",
  "#388881",
  "#64a59a",
  "#a6c9aa",
  "#e2d7a5",
  "#f4b765",
  "#df8358",
  "#b9574d",
  "#593f58",
  "#3b405e",
  "#516681",
  "#8598a2",
  "#c3d2c3",
  "#f6ecd0",
];
export const PHASES = [
  "underpainting",
  "blocking",
  "color",
  "texture",
  "accents",
];
export function validRegion(r) {
  return (
    !!r &&
    ["x", "y", "w", "h"].every((k) => Number.isInteger(r[k])) &&
    Math.abs(r.x) <= LIMIT &&
    Math.abs(r.y) <= LIMIT &&
    r.w >= 1 &&
    r.h >= 1 &&
    r.w <= 8 &&
    r.h <= 8 &&
    r.x + r.w <= LIMIT &&
    r.y + r.h <= LIMIT
  );
}
export function regionPixels(r) {
  return r.w * r.h * TILE * TILE;
}
export function inside(r, p) {
  return (
    p.x >= r.x * TILE &&
    p.y >= r.y * TILE &&
    p.x + p.w <= (r.x + r.w) * TILE &&
    p.y + p.h <= (r.y + r.h) * TILE
  );
}
export function overlaps(a, b) {
  return (
    a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
  );
}
export function screenToWorld(p, c, width, height) {
  return {
    x: (p.x - width / 2) / c.zoom + c.x,
    y: (p.y - height / 2) / c.zoom + c.y,
  };
}
export function zoomAt(c, f, p, width, height) {
  const before = screenToWorld(p, c, width, height);
  const zoom = Math.max(0.2, Math.min(24, c.zoom * f));
  return {
    x: Math.max(
      -LIMIT * TILE,
      Math.min(LIMIT * TILE, before.x - (p.x - width / 2) / zoom),
    ),
    y: Math.max(
      -LIMIT * TILE,
      Math.min(LIMIT * TILE, before.y - (p.y - height / 2) / zoom),
    ),
    zoom,
  };
}
export function tileAt(v) {
  return Math.floor(v / TILE);
}
export function tileKey(x, y) {
  return `${x},${y}`;
}
export function noise(x, y, seed = 1) {
  let n = Math.imul(x + seed * 23, 374761393) + Math.imul(y, 668265263);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}
// Original deterministic pixel painting. The same world-space field joins every region.
export function pigment(x, y, phase = "accents") {
  const u = x % 512,
    v = y % 320,
    n = noise(x, y),
    wave = Math.sin(x / 91) * 12 + Math.sin(x / 37) * 6;
  let c = v < 128 ? 0 : v < 170 + wave ? 2 : v < 208 + wave ? 3 : 1;
  if (v < 120 && n > 0.996) c = 6;
  const dx = u - 340,
    dy = v - 74;
  if (dx * dx + dy * dy < 37 * 37) c = 7;
  if (dx * dx + dy * dy < 31 * 31) c = 6;
  if (v > 117 && v < 143 && Math.sin(x / 50) * 8 + 128 > v) c = 11;
  if (v > 142 + Math.sin(x / 60) * 19 && v < 176 + wave) c = 2;
  if (v > 183 + wave && v < 238 + Math.sin(x / 45) * 8)
    c = noise(Math.floor(x / 9), Math.floor(y / 3)) > 0.55 ? 3 : 2;
  if (
    v > 190 &&
    Math.abs(x - 340) < (v - 180) * 0.7 &&
    noise(Math.floor(x / 7), Math.floor(y / 2)) > 0.45
  )
    c = 5;
  if (v > 242 + Math.sin(x / 46) * 20) c = 0;
  // Hillside cypresses and flowering reeds are sampled, never DOM elements.
  for (const t of [34, 78, 132, 450, 480]) {
    const height = 50 + noise(t, 0) * 75,
      base = 271 + Math.sin(t) * 13;
    if (
      v < base &&
      v > base - height &&
      Math.abs(u - t) <
        (base - v < height * 0.3 ? 9 : (height - (base - v)) * 0.17 + 2)
    )
      c = u < t ? 1 : 2;
  }
  if (v > 252 && n > 0.965) c = n > 0.99 ? 8 : 4;
  if (v > 263 && (Math.floor(x / 4) + Math.floor(y / 4)) % 13 === 0) c = 3;
  if (phase === "underpainting") return c < 6 ? Math.min(c, 3) : 6;
  if (phase === "blocking") return c;
  if (phase === "texture" && n > 0.87 && c < 5) c = Math.min(c + 1, 5);
  return c;
}
export function seededTile(tx, ty) {
  if (tx < 0 || tx >= 16 || ty < 0 || ty >= 10) return null;
  const a = new Uint8Array(TILE * TILE);
  for (let y = 0; y < TILE; y++)
    for (let x = 0; x < TILE; x++)
      a[y * TILE + x] = pigment(tx * TILE + x, ty * TILE + y, "texture");
  return a;
}
export function makePatches(region, phase = "accents", seed = 1) {
  const patches = [];
  const step = phase === "underpainting" ? 8 : phase === "blocking" ? 4 : 2;
  for (let y = region.y * TILE; y < (region.y + region.h) * TILE; y += step)
    for (let x = region.x * TILE; x < (region.x + region.w) * TILE; x += step)
      patches.push({
        x,
        y,
        w: step,
        h: step,
        c: pigment(x + (seed % 2), y, phase),
      });
  return patches;
}
export function applyPatches(getTile, patches) {
  for (const p of patches) {
    for (let ty = tileAt(p.y); ty <= tileAt(p.y + p.h - 1); ty++) {
      for (let tx = tileAt(p.x); tx <= tileAt(p.x + p.w - 1); tx++) {
        const tile = getTile(tx, ty);
        const left = Math.max(p.x, tx * TILE) - tx * TILE;
        const right = Math.min(p.x + p.w, (tx + 1) * TILE) - tx * TILE;
        const top = Math.max(p.y, ty * TILE) - ty * TILE;
        const bottom = Math.min(p.y + p.h, (ty + 1) * TILE) - ty * TILE;
        for (let y = top; y < bottom; y++)
          tile.fill(p.c, y * TILE + left, y * TILE + right);
      }
    }
  }
}
export function estimateTokens(r) {
  return Math.ceil(3500 + regionPixels(r) * 0.4);
}
export class LRU {
  constructor(limit = 512) {
    this.limit = limit;
    this.items = new Map();
  }
  get(k) {
    const v = this.items.get(k);
    if (v !== undefined) {
      this.items.delete(k);
      this.items.set(k, v);
    }
    return v;
  }
  set(k, v) {
    this.items.delete(k);
    this.items.set(k, v);
    while (this.items.size > this.limit)
      this.items.delete(this.items.keys().next().value);
    return v;
  }
}
