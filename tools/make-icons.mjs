// Generates the extension's original icons (colored = media found, gray = idle).
// Pure Node: rasterizes simple shapes with 4x4 supersampling and writes PNGs.
import { deflateSync, crc32 } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'extension', 'icons');
mkdirSync(OUT, { recursive: true });

function png(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Shapes in a unit square [0,1]x[0,1].
function inRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}
function inTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const s = (x1, y1, x2, y2, x3, y3) => (x1 - x3) * (y2 - y3) - (x2 - x3) * (y1 - y3);
  const d1 = s(px, py, ax, ay, bx, by); const d2 = s(px, py, bx, by, cx, cy); const d3 = s(px, py, cx, cy, ax, ay);
  const neg = d1 < 0 || d2 < 0 || d3 < 0; const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

function draw(size, gray) {
  const buf = Buffer.alloc(size * size * 4);
  const SS = 4;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let a = 0; let r = 0; let g = 0; let b = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const u = (x + (sx + 0.5) / SS) / size;
          const v = (y + (sy + 0.5) / SS) / size;
          if (!inRoundRect(u, v, 0.04, 0.04, 0.96, 0.96, 0.22)) continue;
          // background gradient: violet -> coral (colored) or slate (gray)
          const t = (u + v) / 2;
          let cr; let cg; let cb;
          if (gray) { cr = 120 - 30 * t; cg = 128 - 30 * t; cb = 140 - 30 * t; } else { cr = 108 + 140 * t; cg = 76 + 30 * t; cb = 230 - 120 * t; }
          // white glyph: arrow shaft + head + tray
          const shaft = u > 0.43 && u < 0.57 && v > 0.18 && v < 0.52;
          const head = inTriangle(u, v, 0.26, 0.46, 0.74, 0.46, 0.5, 0.70);
          const tray = inRoundRect(u, v, 0.22, 0.76, 0.78, 0.84, 0.03);
          if (shaft || head || tray) { cr = 255; cg = 255; cb = 255; }
          r += cr; g += cg; b += cb; a += 1;
        }
      }
      const i = (y * size + x) * 4;
      const n = SS * SS;
      if (a) { buf[i] = r / a; buf[i + 1] = g / a; buf[i + 2] = b / a; }
      buf[i + 3] = Math.round((a / n) * 255);
    }
  }
  return png(size, buf);
}

for (const s of [16, 32, 48, 128]) {
  writeFileSync(join(OUT, `icon-${s}.png`), draw(s, false));
  writeFileSync(join(OUT, `icon-gray-${s}.png`), draw(s, true));
}
console.log('icons written to', OUT);
