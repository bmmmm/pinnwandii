// SPDX-License-Identifier: GPL-3.0-or-later
// Photo sketches for pinnwandii: a photo becomes a list of translucent
// triangles fitted to a small copy of it (the "primitive" method that SQIP
// uses) and is shown as an SVG. At 9 bytes per triangle a recognizable
// sketch fits into one messenger message together with the greeting; a JPEG
// of the same photo would need about 20 times as much. Pure ESM without DOM
// access; runs in Node and in browsers.
//
// Format:  [w, h, bgR, bgG, bgB, (x1 y1 x2 y2 x3 y3 r g b) × n]
//   w, h 1…255 are the size of the fitted copy; vertices lie on the integer
//   grid 0…w × 0…h; each triangle is painted with ALPHA over the ones before
//   it, so any prefix of the list is a coarser version of the same sketch.

export const SIDE = 128; // long side of the copy the triangles are fitted to
export const MAX_SHAPES = 200;
export const MAX_BYTES = 5 + 9 * MAX_SHAPES;
const HEAD = 5;
const SHAPE = 9;
const ALPHA = 0.5;
const BLUR = 0.8; // softens the triangle edges, in units of the grid

export const shapeCount = (bytes) => (bytes.length - HEAD) / SHAPE;
export const trimSketch = (bytes, n) => bytes.slice(0, HEAD + SHAPE * n);

/** True if `bytes` is a well-formed sketch. */
export function isSketch(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < HEAD || bytes.length > MAX_BYTES) return false;
  if ((bytes.length - HEAD) % SHAPE !== 0) return false;
  const [w, h] = bytes;
  if (w < 1 || h < 1) return false;
  for (let o = HEAD; o < bytes.length; o += SHAPE) {
    for (let k = 0; k < 6; k += 2) {
      if (bytes[o + k] > w || bytes[o + k + 1] > h) return false;
    }
  }
  return true;
}

const hex = (bytes, o) => '#' + [0, 1, 2].map((k) => bytes[o + k].toString(16).padStart(2, '0')).join('');

/** SVG markup for a sketch. Built only from numbers and hex colours. */
export function sketchSvg(bytes) {
  if (!isSketch(bytes)) throw new Error('not a sketch');
  const [w, h] = bytes;
  let paths = '';
  for (let o = HEAD; o < bytes.length; o += SHAPE) {
    const [x1, y1, x2, y2, x3, y3] = bytes.subarray(o, o + 6);
    paths += `<path fill="${hex(bytes, o + 6)}" d="M${x1} ${y1}L${x2} ${y2}L${x3} ${y3}z"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`
    + `<filter id="b"><feGaussianBlur stdDeviation="${BLUR}"/></filter>`
    + `<rect width="${w}" height="${h}" fill="${hex(bytes, 2)}"/>`
    + `<g fill-opacity="${ALPHA}" filter="url(#b)">${paths}</g></svg>`;
}

// ---- fitting ------------------------------------------------------------------

function lcg(seed) {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
}

// Scanline spans [y, xFrom, xTo, …] of the pixels whose centres lie inside
// the triangle, clipped to w × h. Returns the number of entries used.
function spans(t, w, h, out) {
  const [x1, y1, x2, y2, x3, y3] = t;
  const edges = [[x1, y1, x2, y2], [x2, y2, x3, y3], [x3, y3, x1, y1]];
  const yFrom = Math.max(0, Math.ceil(Math.min(y1, y2, y3) - 0.5));
  const yTo = Math.min(h - 1, Math.floor(Math.max(y1, y2, y3) - 0.5));
  let n = 0;
  for (let y = yFrom; y <= yTo; y++) {
    const cy = y + 0.5;
    let lo = Infinity;
    let hi = -Infinity;
    for (const [ax, ay, bx, by] of edges) {
      if ((ay <= cy && by > cy) || (by <= cy && ay > cy)) {
        const x = ax + ((cy - ay) * (bx - ax)) / (by - ay);
        if (x < lo) lo = x;
        if (x > hi) hi = x;
      }
    }
    const xa = Math.max(0, Math.ceil(lo - 0.5));
    const xb = Math.min(w - 1, Math.floor(hi - 0.5));
    if (xa > xb) continue;
    out[n++] = y;
    out[n++] = xa;
    out[n++] = xb;
  }
  return n;
}

/**
 * Fits a sketch to an image: `rgba` holds w × h pixels as RGBA (ImageData
 * layout, alpha ignored), w and h at most 255. Each triangle is the best of
 * random candidates, refined by hill climbing; its colour is the one that
 * minimises the squared error over the pixels it covers. Yields to the
 * event loop now and then so the page stays responsive.
 */
export async function sketch(rgba, w, h, { shapes = MAX_SHAPES, seed = 1, tries = 300, patience = 200 } = {}) {
  const rnd = lcg(seed);
  const px = w * h;
  const target = new Float32Array(px * 3);
  const cur = new Float32Array(px * 3);
  const bg = [0, 0, 0];
  for (let i = 0; i < px; i++) {
    for (let k = 0; k < 3; k++) {
      target[i * 3 + k] = rgba[i * 4 + k];
      bg[k] += rgba[i * 4 + k];
    }
  }
  for (let k = 0; k < 3; k++) bg[k] = Math.round(bg[k] / px);
  for (let i = 0; i < px * 3; i++) cur[i] = bg[i % 3];

  const buf = new Int32Array(h * 3);
  const col = [0, 0, 0];
  const sC = [0, 0, 0], sC2 = [0, 0, 0], sD = [0, 0, 0], sDC = [0, 0, 0];
  // Change of the squared error if `t` were painted in its best colour
  // (left in `col`). With c the colour, C the current and T the target
  // pixel: new = C + ALPHA (c - C), so the change is a quadratic in c
  // whose sums are collected in one pass.
  function score(t) {
    const n = spans(t, w, h, buf);
    let cnt = 0;
    sC.fill(0); sC2.fill(0); sD.fill(0); sDC.fill(0);
    for (let j = 0; j < n; j += 3) {
      const row = buf[j] * w;
      for (let x = buf[j + 1]; x <= buf[j + 2]; x++) {
        const p = (row + x) * 3;
        cnt++;
        for (let k = 0; k < 3; k++) {
          const c = cur[p + k];
          const d = target[p + k] - c;
          sC[k] += c; sC2[k] += c * c; sD[k] += d; sDC[k] += d * c;
        }
      }
    }
    if (!cnt) return Infinity;
    let delta = 0;
    for (let k = 0; k < 3; k++) {
      const c = Math.min(255, Math.max(0, Math.round(sD[k] / (ALPHA * cnt) + sC[k] / cnt)));
      col[k] = c;
      delta += ALPHA * ALPHA * (cnt * c * c - 2 * c * sC[k] + sC2[k]) - 2 * ALPHA * (c * sD[k] - sDC[k]);
    }
    return delta;
  }

  const side = Math.max(w, h);
  const cx = (v) => Math.max(0, Math.min(w, Math.round(v)));
  const cy = (v) => Math.max(0, Math.min(h, Math.round(v)));
  const near = (v) => (rnd() - 0.5) * (side / 4) + v;
  const gauss = () => (rnd() + rnd() + rnd() + rnd() - 2) * 1.7;
  const out = new Uint8Array(HEAD + SHAPE * shapes);
  out.set([w, h, ...bg]);

  for (let s = 0; s < shapes; s++) {
    let best = null;
    let bestE = Infinity;
    for (let i = 0; i < tries; i++) {
      const x = rnd() * w;
      const y = rnd() * h;
      const t = [cx(x), cy(y), cx(near(x)), cy(near(y)), cx(near(x)), cy(near(y))];
      const e = score(t);
      if (e < bestE) { bestE = e; best = t; }
    }
    if (!best) return out.slice(0, HEAD + SHAPE * s); // nothing coverable (1 px image)
    for (let age = 0; age < patience;) {
      const t = best.slice();
      const v = Math.floor(rnd() * 3) * 2;
      t[v] = cx(t[v] + (gauss() * side) / 16);
      t[v + 1] = cy(t[v + 1] + (gauss() * side) / 16);
      const e = score(t);
      if (e < bestE) { bestE = e; best = t; age = 0; } else age++;
    }
    score(best);
    const n = spans(best, w, h, buf);
    for (let j = 0; j < n; j += 3) {
      const row = buf[j] * w;
      for (let x = buf[j + 1]; x <= buf[j + 2]; x++) {
        const p = (row + x) * 3;
        for (let k = 0; k < 3; k++) cur[p + k] += ALPHA * (col[k] - cur[p + k]);
      }
    }
    out.set([...best, ...col], HEAD + SHAPE * s);
    if (s % 16 === 15) await new Promise((r) => setTimeout(r, 0));
  }
  return out;
}
