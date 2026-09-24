import { TILE } from "../shared/world.mjs";
export const planSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    shapes: {
      type: "array",
      minItems: 1,
      maxItems: 64,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          type: { type: "string", enum: ["rect", "ellipse"] },
          x: { type: "integer", minimum: 0, maximum: 255 },
          y: { type: "integer", minimum: 0, maximum: 255 },
          w: { type: "integer", minimum: 1, maximum: 256 },
          h: { type: "integer", minimum: 1, maximum: 256 },
          c: { type: "integer", minimum: 0, maximum: 15 },
        },
        required: ["type", "x", "y", "w", "h", "c"],
      },
    },
  },
  required: ["shapes"],
};
export function rasterize(plan, region) {
  if (
    !plan ||
    Object.keys(plan).some((k) => k !== "shapes") ||
    !Array.isArray(plan.shapes) ||
    !plan.shapes.length ||
    plan.shapes.length > 64
  )
    throw new Error("Invalid composition.");
  const width = region.w * TILE,
    height = region.h * TILE,
    pixels = new Int16Array(width * height).fill(-1);
  for (const s of plan.shapes) {
    if (
      !s ||
      Object.keys(s).some(
        (k) => !["type", "x", "y", "w", "h", "c"].includes(k),
      ) ||
      !["rect", "ellipse"].includes(s.type) ||
      !["x", "y", "w", "h", "c"].every((k) => Number.isInteger(s[k])) ||
      s.x < 0 ||
      s.y < 0 ||
      s.w < 1 ||
      s.h < 1 ||
      s.w > 256 ||
      s.h > 256 ||
      s.x >= width ||
      s.y >= height ||
      s.c < 0 ||
      s.c > 15
    )
      throw new Error("Invalid composition geometry.");
    for (let y = s.y; y < Math.min(height, s.y + s.h); y++)
      for (let x = s.x; x < Math.min(width, s.x + s.w); x++) {
        if (
          s.type === "rect" ||
          ((x + 0.5 - s.x - s.w / 2) / (s.w / 2)) ** 2 +
            ((y + 0.5 - s.y - s.h / 2) / (s.h / 2)) ** 2 <=
            1
        )
          pixels[y * width + x] = s.c;
      }
  }
  const patches = [];
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width;) {
      const c = pixels[y * width + x];
      if (c < 0) {
        x++;
        continue;
      }
      let w = 1;
      while (w < 32 && x + w < width && pixels[y * width + x + w] === c) w++;
      patches.push({
        x: region.x * TILE + x,
        y: region.y * TILE + y,
        w,
        h: 1,
        c,
      });
      x += w;
    }
  return patches;
}
