'use strict';
/**
 * Generate the Island HUD app icon (pixel pet on a dark rounded tile) without
 * any image dependencies: writes PNG entries and wraps them in an ICO file.
 *
 * Outputs:
 *   island/build/icon.ico        (16/24/32/48/64/128/256)
 *   island/build/icon-256.png    (preview / README)
 *
 * Usage: node island/tools/make-icon.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const OUT_DIR = path.resolve(__dirname, '..', 'build');
const SIZES = [16, 24, 32, 48, 64, 128, 256];
const BG = [21, 21, 24];
const ACCENT = [249, 115, 22];
const ACCENT_DARK = [180, 80, 25];

const PET = [
  '..#..#..',
  '.######.',
  '.######.',
  '.######.',
  '..####..',
  '..#..#..',
];

function draw(size) {
  const px = Buffer.alloc(size * size * 4, 0);
  const set = (x, y, r, g, b, a = 255) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
  };
  // rounded dark tile
  const radius = Math.max(3, Math.round(size * 0.22));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let inside = true;
      const cx = x < radius ? radius : x >= size - radius ? size - radius - 1 : x;
      const cy = y < radius ? radius : y >= size - radius ? size - radius - 1 : y;
      if (x < radius || x >= size - radius) {
        const dx = x - cx;
        const dy = y - cy;
        if (dx * dx + dy * dy > (radius - 0.5) * (radius - 0.5)) inside = false;
      }
      if (inside) set(x, y, BG[0], BG[1], BG[2]);
    }
  }
  // subtle inner border on larger sizes
  if (size >= 48) {
    for (let i = radius; i < size - radius; i++) {
      set(i, 1, 42, 42, 48);
      set(i, size - 2, 42, 42, 48);
      set(1, i, 42, 42, 48);
      set(size - 2, i, 42, 42, 48);
    }
  }
  // pixel pet, centered
  const cell = Math.max(1, Math.floor(size * 0.095));
  const petW = 8 * cell;
  const petH = PET.length * cell;
  const ox = Math.round((size - petW) / 2);
  const oy = Math.round((size - petH) / 2);
  for (let gy = 0; gy < PET.length; gy++) {
    for (let gx = 0; gx < 8; gx++) {
      const on = PET[gy][gx] === '#';
      if (!on) continue;
      // eyes: make the two eye cells dark holes
      const isEye = (gy === 2 && (gx === 2 || gx === 5));
      for (let sy = 0; sy < cell; sy++) {
        for (let sx = 0; sx < cell; sx++) {
          if (isEye) set(ox + gx * cell + sx, oy + gy * cell + sy, BG[0], BG[1], BG[2]);
          else {
            const shade = sy === cell - 1 ? ACCENT_DARK : ACCENT;
            set(ox + gx * cell + sx, oy + gy * cell + sy, shade[0], shade[1], shade[2]);
          }
        }
      }
    }
  }
  return px;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const body = Buffer.concat([t, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePNG(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const images = SIZES.map((size) => ({ size, png: encodePNG(size, draw(size)) }));
  fs.writeFileSync(path.join(OUT_DIR, 'icon-256.png'), images[images.length - 1].png);

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const entries = [];
  let offset = 6 + 16 * images.length;
  for (const { size, png } of images) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size;
    e[1] = size >= 256 ? 0 : size;
    e[2] = 0;
    e[3] = 0;
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += png.length;
  }
  const ico = Buffer.concat([header, ...entries, ...images.map((i) => i.png)]);
  fs.writeFileSync(path.join(OUT_DIR, 'icon.ico'), ico);
  console.log(`icon.ico ${ico.length} bytes (${SIZES.join('/')})`);
  console.log(`icon-256.png ${images[images.length - 1].png.length} bytes`);
}

main();
