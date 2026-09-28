/**
 * 托盘模板图标生成器（WP2）：灵鹊 logo 的几何剪影——三圆两线，黑+alpha。
 * macOS template 图只取 alpha 通道，菜单栏明暗主题自动反色；
 * 原 icon1024 是深色底整方块，直接缩放会成一坨实心块，故按几何重绘。
 * 4x 超采样抗锯齿；零依赖纯 node 写 PNG。跑法：node scripts/make-tray-icon.mjs
 */
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ---- CRC32 / PNG 封装 ----
const crcTable = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c;
}
function crc32(buf) {
  let c = -1;
  for (const b of buf) c = (c >>> 8) ^ crcTable[(c ^ b) & 0xff];
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function pngRgba(size, px) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter none
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---- 几何（36 网格，等比缩放到目标尺寸）：三圆 + 两条连线 ----
const CIRCLES = [
  [18, 9, 5.6],
  [9, 27, 5.6],
  [27, 27, 5.6],
];
const SEGMENTS = [
  [18, 9, 9, 27],
  [18, 9, 27, 27],
];
const SEG_W = 3.4;

function distToSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = x1 + t * dx;
  const cy = y1 + t * dy;
  return Math.hypot(px - cx, py - cy);
}

function inside(gx, gy) {
  for (const [cx, cy, r] of CIRCLES) {
    if (Math.hypot(gx - cx, gy - cy) <= r) return true;
  }
  for (const [x1, y1, x2, y2] of SEGMENTS) {
    if (distToSeg(gx, gy, x1, y1, x2, y2) <= SEG_W / 2) return true;
  }
  return false;
}

function render(size) {
  const px = Buffer.alloc(size * size * 4);
  const SS = 4; // 超采样倍数
  const scale = 36 / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let covered = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const gx = (x + (sx + 0.5) / SS) * scale;
          const gy = (y + (sy + 0.5) / SS) * scale;
          if (inside(gx, gy)) covered++;
        }
      }
      const alpha = Math.round((covered / (SS * SS)) * 255);
      const off = (y * size + x) * 4;
      px[off] = 0;
      px[off + 1] = 0;
      px[off + 2] = 0;
      px[off + 3] = alpha;
    }
  }
  return pngRgba(size, px);
}

const assetsDir = join(dirname(dirname(fileURLToPath(import.meta.url))), "assets");
writeFileSync(join(assetsDir, "trayTemplate.png"), render(18));
writeFileSync(join(assetsDir, "trayTemplate@2x.png"), render(36));
console.log("✅ assets/trayTemplate.png (18px) + trayTemplate@2x.png (36px) 已生成");
