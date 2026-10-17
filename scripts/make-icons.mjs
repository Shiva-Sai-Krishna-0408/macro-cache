// Generates PWA PNG icons (no dependencies): node scripts/make-icons.mjs
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const BG = hex("#0b0f14"), TRACK = hex("#243041"), ACCENT = hex("#3fb950"), DOT = hex("#e6edf3");

function icon(size, { maskable = false, rounded = true } = {}) {
  const ss = 4; // supersampling
  const px = Buffer.alloc(size * size * 4);
  const scale = maskable ? 0.72 : 1; // keep the mark inside the maskable safe zone
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      let acc = [0, 0, 0, 0];
      for (let sy = 0; sy < ss; sy++)
        for (let sx = 0; sx < ss; sx++) {
          const u = ((x + (sx + 0.5) / ss) / size) * 64;
          const v = ((y + (sy + 0.5) / ss) / size) * 64;
          let col = null;
          // background (rounded square unless maskable/full-bleed)
          const r = rounded && !maskable ? 14 : 0;
          const qx = Math.max(Math.abs(u - 32) - (32 - r), 0), qy = Math.max(Math.abs(v - 32) - (32 - r), 0);
          if (Math.hypot(qx, qy) <= r) col = BG;
          const cu = 32 + (u - 32) / scale, cv = 32 + (v - 32) / scale;
          const d = Math.hypot(cu - 32, cv - 32);
          if (col && d >= 15.5 && d <= 22.5) {
            const ang = (Math.atan2(cv - 32, cu - 32) * 180) / Math.PI; // -180..180, 0 = east
            const fromTop = (ang + 90 + 360) % 360; // 0 at top, clockwise
            col = fromTop <= 302 ? ACCENT : TRACK;
          }
          if (col && d <= 6) col = DOT;
          if (col) acc = [acc[0] + col[0], acc[1] + col[1], acc[2] + col[2], acc[3] + 255];
        }
      const n = ss * ss, i = (y * size + x) * 4, a = acc[3] / n;
      px[i] = a ? acc[0] / (acc[3] / 255) : 0;
      px[i + 1] = a ? acc[1] / (acc[3] / 255) : 0;
      px[i + 2] = a ? acc[2] / (acc[3] / 255) : 0;
      px[i + 3] = a;
    }
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const out = "apps/dashboard/public";
writeFileSync(`${out}/icon-192.png`, icon(192));
writeFileSync(`${out}/icon-512.png`, icon(512));
writeFileSync(`${out}/icon-maskable-512.png`, icon(512, { maskable: true }));
writeFileSync(`${out}/apple-touch-icon.png`, icon(180, { rounded: false }));
console.log("icons written");
