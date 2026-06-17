// 生成 1024×1024 的 DayLog 应用图标源 PNG（无外部依赖，仅用 Node zlib）。
// 设计：强调色圆角方块底 + 白色日历本（两个环 + 三条记录线），呼应"日程记录"。
// 产物交给 `tauri icon` 切出 .ico / 各尺寸 png。
import zlib from "node:zlib";
import { writeFileSync } from "node:fs";

const S = 2; // 超采样倍率，最后 2×2 平均下采样得到抗锯齿
const N = 1024;
const W = N * S;
const buf = new Float32Array(W * W * 4); // RGBA，预乘前的直接值，0..255

function blend(x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= W || y >= W || a <= 0) return;
  const i = (y * W + x) * 4;
  const ia = 1 - a;
  buf[i] = r * a + buf[i] * ia;
  buf[i + 1] = g * a + buf[i + 1] * ia;
  buf[i + 2] = b * a + buf[i + 2] * ia;
  buf[i + 3] = a * 255 + buf[i + 3] * ia;
}

// 圆角矩形覆盖测试（命中返回 1）
function inRound(px, py, x0, y0, x1, y1, rad) {
  if (px < x0 || py < y0 || px >= x1 || py >= y1) return false;
  const cx = px < x0 + rad ? x0 + rad : px > x1 - rad ? x1 - rad : px;
  const cy = py < y0 + rad ? y0 + rad : py > y1 - rad ? y1 - rad : py;
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= rad * rad;
}

function fillRound(x0, y0, x1, y1, rad, [r, g, b], a = 1) {
  const s = S;
  for (let y = Math.floor(y0 * s); y < Math.ceil(y1 * s); y++) {
    for (let x = Math.floor(x0 * s); x < Math.ceil(x1 * s); x++) {
      if (inRound(x + 0.5, y + 0.5, x0 * s, y0 * s, x1 * s, y1 * s, rad * s)) {
        blend(x, y, r, g, b, a);
      }
    }
  }
}

const ACCENT = [0x4f, 0x6e, 0xf7];
const ACCENT_DK = [0x3f, 0x59, 0xd8];
const WHITE = [0xff, 0xff, 0xff];

// 底：圆角方块（留出一点边距），竖向轻微渐变
{
  const m = 64, rad = 224;
  const x0 = m, y0 = m, x1 = N - m, y1 = N - m;
  const s = S;
  for (let y = Math.floor(y0 * s); y < Math.ceil(y1 * s); y++) {
    const t = (y / s - y0) / (y1 - y0);
    const r = ACCENT[0] + (0x60 - ACCENT[0]) * (1 - t);
    const g = ACCENT[1] + (0x84 - ACCENT[1]) * (1 - t);
    const b = ACCENT[2] + (0xff - ACCENT[2]) * (1 - t);
    for (let x = Math.floor(x0 * s); x < Math.ceil(x1 * s); x++) {
      if (inRound(x + 0.5, y + 0.5, x0 * s, y0 * s, x1 * s, y1 * s, rad * s)) {
        blend(x, y, r, g, b, 1);
      }
    }
  }
}

// 日历本体：白色圆角矩形
fillRound(264, 320, 760, 768, 56, WHITE);
// 顶部色条
fillRound(264, 320, 760, 432, 56, ACCENT_DK);
fillRound(264, 400, 760, 432, 0, ACCENT_DK); // 补平色条下沿（去掉下方圆角）
// 两个挂环
fillRound(372, 276, 428, 372, 28, WHITE);
fillRound(596, 276, 652, 372, 28, WHITE);
// 三条记录线（长度递减）
fillRound(332, 500, 692, 540, 20, ACCENT);
fillRound(332, 576, 640, 616, 20, ACCENT);
fillRound(332, 652, 560, 692, 20, [0x9a, 0xab, 0xfb]);

// 下采样 2×2 平均
const out = Buffer.alloc(N * N * 4);
for (let y = 0; y < N; y++) {
  for (let x = 0; x < N; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let dy = 0; dy < S; dy++)
      for (let dx = 0; dx < S; dx++) {
        const i = ((y * S + dy) * W + (x * S + dx)) * 4;
        r += buf[i]; g += buf[i + 1]; b += buf[i + 2]; a += buf[i + 3];
      }
    const n = S * S;
    const o = (y * N + x) * 4;
    out[o] = Math.round(r / n);
    out[o + 1] = Math.round(g / n);
    out[o + 2] = Math.round(b / n);
    out[o + 3] = Math.round(a / n);
  }
}

// --- 最小 PNG 编码（RGBA, colortype 6） ---
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(b) {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(N, 0);
ihdr.writeUInt32BE(N, 4);
ihdr[8] = 8;  // bit depth
ihdr[9] = 6;  // RGBA
// raw with filter byte 0 per row
const raw = Buffer.alloc(N * (N * 4 + 1));
for (let y = 0; y < N; y++) {
  raw[y * (N * 4 + 1)] = 0;
  out.copy(raw, y * (N * 4 + 1) + 1, y * N * 4, (y + 1) * N * 4);
}
const idat = zlib.deflateSync(raw, { level: 9 });
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk("IHDR", ihdr),
  chunk("IDAT", idat),
  chunk("IEND", Buffer.alloc(0)),
]);
const dest = new URL("../src-tauri/icon-source.png", import.meta.url);
writeFileSync(dest, png);
console.log("wrote", dest.pathname, png.length, "bytes");
