// SPDX-License-Identifier: GPL-3.0-or-later
// Small JPEGs whose header can be left out of a link. A baseline JPEG is
// ~590 bytes of tables before the first pixel; this encoder always uses the
// same tables (the example tables of the JPEG standard, Annex K, scaled by
// quality like libjpeg), so the header follows from width, height and
// quality alone. A link carries only [1, quality, width, height, scan…]
// and the header is put back before the browser decodes the photo. At
// ~1 KB that roughly doubles the picture data compared to a normal JPEG
// (canvas encoders cannot be used for this: Chrome optimizes its tables per
// image). Pure ESM without DOM access; runs in Node and in browsers.

const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
];
const Q_LUMA = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
];
const Q_CHROMA = [17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99, ...new Array(32).fill(99)];
// Huffman tables: code counts per length 1…16, then the symbols.
const DC_LUMA = [[0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]];
const DC_CHROMA = [[0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]];
const AC_LUMA = [[0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d], [
  0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08,
  0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
  0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59,
  0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
  0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6,
  0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
  0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa]];
const AC_CHROMA = [[0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77], [
  0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71, 0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91,
  0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0, 0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26,
  0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58,
  0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87,
  0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4,
  0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda,
  0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa]];

const MAX_SIDE = 255; // width and height travel as one byte each
const STRIPPED = 1; // first byte of a stripped JPEG

// Symbol -> [code, length] for a canonical Huffman table.
function huffman([counts, symbols]) {
  const map = new Map();
  let code = 0;
  let k = 0;
  for (let len = 1; len <= 16; len++) {
    for (let i = 0; i < counts[len - 1]; i++) map.set(symbols[k++], [code++, len]);
    code <<= 1;
  }
  return map;
}
const H = { dcY: huffman(DC_LUMA), acY: huffman(AC_LUMA), dcC: huffman(DC_CHROMA), acC: huffman(AC_CHROMA) };

// libjpeg's quality scaling (jpeg_quality_scaling + jpeg_add_quant_table).
function quantTable(base, q) {
  const scale = q < 50 ? 5000 / q : 200 - 2 * q;
  return base.map((v) => Math.min(255, Math.max(1, Math.floor((v * scale + 50) / 100))));
}
const validSize = (w, h) => Number.isInteger(w) && Number.isInteger(h) && w >= 1 && h >= 1 && w <= MAX_SIDE && h <= MAX_SIDE;
const validQuality = (q) => Number.isInteger(q) && q >= 1 && q <= 100;

/** The header this encoder writes for a w × h photo at quality q (1…100). */
export function jpegHeader(w, h, q) {
  const out = [0xff, 0xd8];
  const segment = (marker, body) => out.push(0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 255, ...body);
  const qy = quantTable(Q_LUMA, q);
  const qc = quantTable(Q_CHROMA, q);
  segment(0xdb, [0, ...ZIGZAG.map((i) => qy[i]), 1, ...ZIGZAG.map((i) => qc[i])]);
  // 3 components, luma sampled 2×2 (4:2:0), chroma using table 1
  segment(0xc0, [8, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  segment(0xc4, [0x00, ...DC_LUMA.flat(), 0x10, ...AC_LUMA.flat(), 0x01, ...DC_CHROMA.flat(), 0x11, ...AC_CHROMA.flat()]);
  segment(0xda, [3, 1, 0x00, 2, 0x11, 3, 0x11, 0, 63, 0]);
  return Uint8Array.from(out);
}
const HEADER_LENGTH = jpegHeader(1, 1, 50).length;
const SOF_SIZE = 141; // offset of height, width in the header

// 8×8 forward DCT, separable, with the JPEG normalisation.
const COS = new Float64Array(64);
for (let x = 0; x < 8; x++) {
  for (let u = 0; u < 8; u++) COS[x * 8 + u] = Math.cos(((2 * x + 1) * u * Math.PI) / 16) * (u ? 0.5 : Math.SQRT1_2 / 2);
}
function fdct(block, tmp, out) {
  for (let y = 0; y < 8; y++) {
    for (let u = 0; u < 8; u++) {
      let s = 0;
      for (let x = 0; x < 8; x++) s += block[y * 8 + x] * COS[x * 8 + u];
      tmp[y * 8 + u] = s;
    }
  }
  for (let u = 0; u < 8; u++) {
    for (let v = 0; v < 8; v++) {
      let s = 0;
      for (let y = 0; y < 8; y++) s += tmp[y * 8 + u] * COS[y * 8 + v];
      out[v * 8 + u] = s;
    }
  }
}

/** Baseline JPEG of w × h RGBA pixels (alpha ignored) at quality q (1…100). */
export function encodeJpeg(rgba, w, h, q) {
  if (!validSize(w, h) || !validQuality(q)) throw new RangeError('size or quality out of range');
  const qy = quantTable(Q_LUMA, q);
  const qc = quantTable(Q_CHROMA, q);
  const bytes = Array.from(jpegHeader(w, h, q));
  let acc = 0;
  let bits = 0;
  const put = (code, len) => {
    acc = (acc << len) | code;
    bits += len;
    while (bits >= 8) {
      const b = (acc >> (bits - 8)) & 255;
      bytes.push(b);
      if (b === 255) bytes.push(0); // byte stuffing
      bits -= 8;
    }
    acc &= (1 << bits) - 1;
  };
  const category = (v) => {
    let a = Math.abs(v);
    let c = 0;
    while (a) { c++; a >>= 1; }
    return c;
  };
  const pred = [0, 0, 0];
  const block = new Float64Array(64);
  const tmp = new Float64Array(64);
  const coef = new Float64Array(64);
  const zz = new Int32Array(64);
  function encodeBlock(comp, qt, dc, ac) {
    fdct(block, tmp, coef);
    for (let k = 0; k < 64; k++) zz[k] = Math.round(coef[ZIGZAG[k]] / qt[ZIGZAG[k]]);
    const diff = zz[0] - pred[comp];
    pred[comp] = zz[0];
    let c = category(diff);
    put(...dc.get(c));
    if (c) put(diff < 0 ? diff + (1 << c) - 1 : diff, c);
    let run = 0;
    for (let k = 1; k < 64; k++) {
      if (!zz[k]) { run++; continue; }
      for (; run > 15; run -= 16) put(...ac.get(0xf0));
      c = category(zz[k]);
      put(...ac.get((run << 4) | c));
      put(zz[k] < 0 ? zz[k] + (1 << c) - 1 : zz[k], c);
      run = 0;
    }
    if (run) put(...ac.get(0x00));
  }
  // Pixels beyond the edge repeat the last row and column.
  const at = (x, y) => (Math.min(h - 1, y) * w + Math.min(w - 1, x)) * 4;
  const luma = (p) => 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
  const cb = (p) => -0.168736 * rgba[p] - 0.331264 * rgba[p + 1] + 0.5 * rgba[p + 2] + 128;
  const cr = (p) => 0.5 * rgba[p] - 0.418688 * rgba[p + 1] - 0.081312 * rgba[p + 2] + 128;
  for (let my = 0; my < h; my += 16) {
    for (let mx = 0; mx < w; mx += 16) {
      for (const [ox, oy] of [[0, 0], [8, 0], [0, 8], [8, 8]]) {
        for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) block[j * 8 + i] = luma(at(mx + ox + i, my + oy + j)) - 128;
        encodeBlock(0, qy, H.dcY, H.acY);
      }
      for (const [comp, f] of [[1, cb], [2, cr]]) {
        for (let j = 0; j < 8; j++) {
          for (let i = 0; i < 8; i++) {
            const x = mx + 2 * i;
            const y = my + 2 * j;
            block[j * 8 + i] = (f(at(x, y)) + f(at(x + 1, y)) + f(at(x, y + 1)) + f(at(x + 1, y + 1))) / 4 - 128;
          }
        }
        encodeBlock(comp, qc, H.dcC, H.acC);
      }
    }
  }
  if (bits) put((1 << (8 - bits)) - 1, 8 - bits); // pad with 1 bits
  bytes.push(0xff, 0xd9);
  return Uint8Array.from(bytes);
}

/** [1, q, w, h, …scan] if `jpeg` was written by encodeJpeg, else null. */
export function stripJpeg(jpeg) {
  if (!(jpeg instanceof Uint8Array) || jpeg.length < HEADER_LENGTH + 2) return null;
  if (jpeg[jpeg.length - 2] !== 0xff || jpeg[jpeg.length - 1] !== 0xd9) return null;
  const h = (jpeg[SOF_SIZE] << 8) | jpeg[SOF_SIZE + 1];
  const w = (jpeg[SOF_SIZE + 2] << 8) | jpeg[SOF_SIZE + 3];
  if (!validSize(w, h)) return null;
  for (let q = 1; q <= 100; q++) {
    const qy = quantTable(Q_LUMA, q);
    if (!ZIGZAG.every((z, k) => jpeg[7 + k] === qy[z])) continue; // cheap check on the luma table first
    const head = jpegHeader(w, h, q);
    if (head.every((b, i) => jpeg[i] === b)) {
      const out = new Uint8Array(4 + jpeg.length - HEADER_LENGTH - 2);
      out.set([STRIPPED, q, w, h]);
      out.set(jpeg.subarray(HEADER_LENGTH, jpeg.length - 2), 4);
      return out;
    }
  }
  return null;
}

/** Length of stripJpeg(jpeg) for a JPEG written by encodeJpeg. */
export const strippedLength = (jpeg) => jpeg.length - HEADER_LENGTH - 2 + 4;

/** The full JPEG for stripped bytes, or null if they are not a stripped JPEG. */
export function unstripJpeg(stripped) {
  if (!(stripped instanceof Uint8Array) || stripped.length < 5 || stripped[0] !== STRIPPED) return null;
  const [, q, w, h] = stripped;
  if (!validSize(w, h) || !validQuality(q)) return null;
  const out = new Uint8Array(HEADER_LENGTH + stripped.length - 4 + 2);
  out.set(jpegHeader(w, h, q));
  out.set(stripped.subarray(4), HEADER_LENGTH);
  out.set([0xff, 0xd9], out.length - 2);
  return out;
}

/**
 * Structural similarity of two images' luma (w × h RGBA each), 8 × 8
 * windows every 4 pixels: 1 is identical. Used to pick, per photo, the size
 * and quality that look best within a byte budget.
 */
export function ssim(a, b, w, h) {
  const C1 = (0.01 * 255) ** 2;
  const C2 = (0.03 * 255) ** 2;
  const la = new Float64Array(w * h);
  const lb = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) {
    la[i] = 0.299 * a[i * 4] + 0.587 * a[i * 4 + 1] + 0.114 * a[i * 4 + 2];
    lb[i] = 0.299 * b[i * 4] + 0.587 * b[i * 4 + 1] + 0.114 * b[i * 4 + 2];
  }
  let sum = 0;
  let n = 0;
  for (let y = 0; y + 8 <= h; y += 4) {
    for (let x = 0; x + 8 <= w; x += 4) {
      let ma = 0, mb = 0;
      for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) { ma += la[(y + j) * w + x + i]; mb += lb[(y + j) * w + x + i]; }
      ma /= 64; mb /= 64;
      let va = 0, vb = 0, cov = 0;
      for (let j = 0; j < 8; j++) {
        for (let i = 0; i < 8; i++) {
          const da = la[(y + j) * w + x + i] - ma;
          const db = lb[(y + j) * w + x + i] - mb;
          va += da * da; vb += db * db; cov += da * db;
        }
      }
      va /= 63; vb /= 63; cov /= 63;
      sum += ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2));
      n++;
    }
  }
  return n ? sum / n : 1;
}
