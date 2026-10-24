'use strict';
/**
 * Synchronize the official Pixel Console exports into every runtime icon slot.
 * The committed design PNGs keep this step dependency-free; refresh them first
 * with `node design/logo/export-icons.cjs` after editing the SVG.
 *
 * Outputs:
 *   build/icon.ico                 Windows installer / executable icon
 *   build/icon-256.png             packaging preview
 *   src/renderer/assets/icon.svg   settings-page brand mark
 *   src/renderer/assets/icon-*.png Electron tray and window icons
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DESIGN = path.join(ROOT, 'design/logo');
const BUILD = path.join(ROOT, 'build');
const RUNTIME = path.join(ROOT, 'src/renderer/assets');
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function validatePng(buffer, expectedSize, source) {
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error(`Not a PNG: ${source}`);
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (width !== expectedSize || height !== expectedSize) {
    throw new Error(`${source}: expected ${expectedSize}x${expectedSize}, got ${width}x${height}`);
  }
}

function validateIco(buffer, source) {
  if (buffer.readUInt16LE(0) !== 0 || buffer.readUInt16LE(2) !== 1
    || buffer.readUInt16LE(4) !== ICO_SIZES.length) {
    throw new Error(`Unexpected ICO header: ${source}`);
  }
  ICO_SIZES.forEach((size, index) => {
    const entry = 6 + index * 16;
    const width = buffer[entry] || 256;
    const height = buffer[entry + 1] || 256;
    const length = buffer.readUInt32LE(entry + 8);
    const offset = buffer.readUInt32LE(entry + 12);
    if (width !== size || height !== size || offset + length > buffer.length) {
      throw new Error(`Invalid ICO entry for ${size}px: ${source}`);
    }
    validatePng(buffer.subarray(offset, offset + length), size, `${source} (${size}px)`);
  });
}

function main() {
  const copies = [
    { source: 'island-hud-logo.ico', destination: path.join(BUILD, 'icon.ico'), validate: validateIco },
    ...[16, 32, 256].flatMap((size) => [
      { source: `island-hud-logo-${size}.png`, destination: path.join(RUNTIME, `icon-${size}.png`), size },
      ...(size === 256 ? [{ source: 'island-hud-logo-256.png', destination: path.join(BUILD, 'icon-256.png'), size }] : []),
    ]),
    { source: 'island-hud-logo.svg', destination: path.join(RUNTIME, 'icon.svg') },
  ].map((entry) => {
    const source = path.join(DESIGN, entry.source);
    if (!fs.existsSync(source)) {
      throw new Error(`Missing ${source}. Run node design/logo/export-icons.cjs first.`);
    }
    const buffer = fs.readFileSync(source);
    if (entry.size) validatePng(buffer, entry.size, source);
    if (entry.validate) entry.validate(buffer, source);
    return { ...entry, buffer };
  });

  for (const entry of copies) {
    fs.mkdirSync(path.dirname(entry.destination), { recursive: true });
    fs.writeFileSync(entry.destination, entry.buffer);
    console.log(`${path.relative(ROOT, entry.destination)} (${entry.buffer.length} bytes)`);
  }
}

main();
