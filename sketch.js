// SPDX-License-Identifier: GPL-3.0-or-later
// Photo sketches, read-only: version 2 links carried a photo as translucent
// triangles fitted to it, shown as SVG. New photos are small JPEGs (jpeg.js),
// which look better at the same size; this module keeps boards and links
// from version 2 readable. Pure ESM without DOM access.
//
// Format:  [w, h, bgR, bgG, bgB, (x1 y1 x2 y2 x3 y3 r g b) × n]
//   w, h 1…255; vertices lie on the integer grid 0…w × 0…h; each triangle
//   is painted with ALPHA over the ones before it.

export const MAX_SHAPES = 200;
export const MAX_BYTES = 5 + 9 * MAX_SHAPES;
const HEAD = 5;
const SHAPE = 9;
const ALPHA = 0.5;
const BLUR = 0.8; // softens the triangle edges, in units of the grid

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
