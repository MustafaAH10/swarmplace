import { validRegion, TILE, PALETTE, tileKey } from "./world.mjs";

export function selectionHash(region) {
  if (!validRegion(region)) throw new Error("Invalid selection.");
  return `#selection=${region.x},${region.y},${region.w},${region.h}`;
}

export function parseSelectionHash(hash) {
  const match = /^#selection=(-?\d+),(-?\d+),(\d+),(\d+)$/.exec(hash);
  if (!match) return null;
  const [x, y, w, h] = match.slice(1).map(Number);
  const region = { x, y, w, h };
  return validRegion(region) ? region : null;
}

// Split the largest remaining region, preserving every selected tile exactly once.
export function splitSelection(region, limit = 4) {
  if (
    !validRegion(region) ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 4
  )
    throw new Error("Invalid swarm selection.");
  const parts = [{ ...region }];
  while (parts.length < limit) {
    const candidates = parts
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => r.w * r.h > 1)
      .sort((a, b) => b.r.w * b.r.h - a.r.w * a.r.h);
    if (!candidates.length) break;
    const { r, i } = candidates[0];
    const axis = r.w >= r.h ? "w" : "h";
    const half = Math.floor(r[axis] / 2);
    const first = { ...r, [axis]: half };
    const second = {
      ...r,
      [axis]: r[axis] - half,
      [axis === "w" ? "x" : "y"]: r[axis === "w" ? "x" : "y"] + half,
    };
    parts.splice(i, 1, first, second);
  }
  return parts;
}

// Export source pixels, without selection outlines, cursors or view transforms.
export function selectionRGBA(region, tiles) {
  if (!validRegion(region)) throw new Error("Invalid selection.");
  const width = region.w * TILE,
    height = region.h * TILE;
  const rgba = new Uint8ClampedArray(width * height * 4);
  const palette = PALETTE.map((hex) =>
    [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)),
  );
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const tile = tiles.get(
        tileKey(
          region.x + Math.floor(x / TILE),
          region.y + Math.floor(y / TILE),
        ),
      );
      const color = tile && palette[tile[(y % TILE) * TILE + (x % TILE)]];
      if (!color) continue;
      const offset = (y * width + x) * 4;
      rgba.set([...color, 255], offset);
    }
  return { width, height, rgba };
}
