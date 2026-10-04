// Generates PNG favicons from favicon.ico so the site meets Google's
// favicon guidance (a size that's a multiple of 48px square). The .ico
// itself is left untouched and keeps serving the browsers.
//
// Usage: node _scripts/generate-icons.js

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const ICO = path.join(ROOT, 'favicon.ico');

const TARGETS = [
  ['favicon-48x48.png', 48],
  ['favicon-96x96.png', 96],
  ['apple-touch-icon.png', 180],
];

// Reads the largest 32bpp bitmap out of an .ico file as top-down RGBA.
function readLargestIcoImage(file) {
  const b = fs.readFileSync(file);
  if (b.length < 6 || b.readUInt16LE(0) !== 0 || b.readUInt16LE(2) !== 1) {
    throw new Error(file + ' is not an ICO file');
  }
  const count = b.readUInt16LE(4);
  let best = null;
  for (let i = 0; i < count; i++) {
    const o = 6 + i * 16;
    const entry = {
      w: b[o] || 256,
      h: b[o + 1] || 256,
      size: b.readUInt32LE(o + 8),
      off: b.readUInt32LE(o + 12),
    };
    if (!best || entry.w * entry.h > best.w * best.h) best = entry;
  }
  if (!best) throw new Error('ICO contains no images');

  const d = b.slice(best.off, best.off + best.size);
  const headerSize = d.readUInt32LE(0);
  const width = d.readInt32LE(4);
  const height = d.readInt32LE(8) / 2; // ICO stacks XOR + AND bitmaps
  const bpp = d.readUInt16LE(14);
  if (bpp !== 32) throw new Error('expected a 32bpp bitmap, got ' + bpp + 'bpp');

  const pixels = d.slice(headerSize, headerSize + width * height * 4);
  const data = Buffer.alloc(width * height * 4);
  let anyAlpha = false;
  for (let y = 0; y < height; y++) {
    const src = (height - 1 - y) * width * 4; // stored bottom-up
    for (let x = 0; x < width; x++) {
      const s = src + x * 4;
      const t = (y * width + x) * 4;
      data[t] = pixels[s + 2]; // BGR(A) -> RGB(A)
      data[t + 1] = pixels[s + 1];
      data[t + 2] = pixels[s];
      data[t + 3] = pixels[s + 3];
      if (pixels[s + 3] !== 0) anyAlpha = true;
    }
  }
  if (!anyAlpha) {
    // Icons relying on the AND mask only: treat as fully opaque.
    for (let i = 3; i < data.length; i += 4) data[i] = 255;
  }
  return { width, height, data };
}

// Bilinear resample, interpolating premultiplied alpha so transparent
// edges don't bleed dark fringes.
function resample(src, dw, dh) {
  const sw = src.width;
  const sh = src.height;
  const s = src.data;
  const out = Buffer.alloc(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(sh - 1, Math.max(0, ((y + 0.5) * sh) / dh - 0.5));
    const y0 = Math.floor(sy);
    const y1 = Math.min(sh - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(sw - 1, Math.max(0, ((x + 0.5) * sw) / dw - 0.5));
      const x0 = Math.floor(sx);
      const x1 = Math.min(sw - 1, x0 + 1);
      const fx = sx - x0;
      const corners = [
        [x0, y0, (1 - fx) * (1 - fy)],
        [x1, y0, fx * (1 - fy)],
        [x0, y1, (1 - fx) * fy],
        [x1, y1, fx * fy],
      ];
      let r = 0;
      let g = 0;
      let bl = 0;
      let a = 0;
      for (const [cx, cy, w] of corners) {
        if (w === 0) continue;
        const i = (cy * sw + cx) * 4;
        const alpha = s[i + 3] / 255;
        r += s[i] * alpha * w;
        g += s[i + 1] * alpha * w;
        bl += s[i + 2] * alpha * w;
        a += s[i + 3] * w;
      }
      const t = (y * dw + x) * 4;
      const outA = Math.round(a);
      out[t + 3] = outA;
      if (outA > 0) {
        out[t] = Math.min(255, Math.round((r * 255) / outA));
        out[t + 1] = Math.min(255, Math.round((g * 255) / outA));
        out[t + 2] = Math.min(255, Math.round((bl * 255) / outA));
      }
    }
  }
  return { width: dw, height: dh, data: out };
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(img) {
  const { width, height, data } = img;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour with alpha
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0; // filter: None
    data.copy(raw, y * stride + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return {
    png: Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      pngChunk('IHDR', ihdr),
      pngChunk('IDAT', idat),
      pngChunk('IEND', Buffer.alloc(0)),
    ]),
    raw,
  };
}

// Re-reads a generated PNG and proves the pixels survive the round trip.
function verifyPng(file, raw) {
  const b = fs.readFileSync(file);
  const sig = b.slice(0, 8).toString('hex');
  if (sig !== '89504e470d0a1a0a') throw new Error(file + ': bad PNG signature');
  const width = b.readUInt32BE(16);
  const height = b.readUInt32BE(20);
  const idatLen = b.readUInt32BE(33);
  const idat = b.slice(41, 41 + idatLen);
  if (!zlib.inflateSync(idat).equals(raw)) throw new Error(file + ': IDAT does not match source pixels');
  return width + 'x' + height;
}

const source = readLargestIcoImage(ICO);
console.log('source favicon.ico bitmap:', source.width + 'x' + source.height);
for (const [name, size] of TARGETS) {
  const img = resample(source, size, size);
  const { png, raw } = encodePng(img);
  const file = path.join(ROOT, name);
  fs.writeFileSync(file, png);
  console.log(name, png.length + ' bytes', verifyPng(file, raw), 'verified');
}
