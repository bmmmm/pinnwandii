// SPDX-License-Identifier: GPL-3.0-or-later
// Run: node --test test.mjs
import { test } from 'node:test';
import { deepEqual, equal, ok, rejects, throws } from 'node:assert/strict';
import {
  LIMITS, addContrib, decodeBoard, decodeContrib, decodeInvite, encodeBoard,
  encodeContrib, encodeInvite, extractContribs, fromBase64, fromBase64url, imgSrc,
  mergeContribs, mergeText, pack, sketchImg, toBase64, toBase64url, toTuple, unpack, validate,
} from './codec.js';
import { MAX_SHAPES, isSketch, shapeCount, sketch, sketchSvg, trimSketch } from './sketch.js';

const ID = 'AbC-_9';
const board = {
  id: ID, title: 'Alles Gute zum 80., Oma! 🎂', preset: 'b', hue: 300,
  contribs: [
    { name: 'Zoë Müller', text: 'Alles Gute!\nWir denken an dich 🎉🥳', sticker: '🎂', img: '' },
    { name: 'سارة', text: 'مبارك! שלום', sticker: '', img: 'https://example.org/p.jpg' },
    { name: 'Ólafur', text: 'Æ Ø Å – „Gänsefüßchen“', sticker: '🍀', img: '' },
  ],
};
const contrib = { id: ID, name: 'Anna', text: 'Herzlichen Glückwunsch!', sticker: '🎉', img: '' };

// Deterministic pseudo-random bytes / text so a red run is reproducible.
function lcg(seed) {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0);
}
function randomBytes(n, seed = 7) {
  const next = lcg(seed);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = next() >>> 24;
  return out;
}
const photo = (bytes) => 'data:image/jpeg;base64,' + toBase64(bytes);

test('1 board round-trip keeps umlauts, emoji, newlines and RTL text', async () => {
  const tok = await encodeBoard(board);
  ok(tok.startsWith('2.'));
  deepEqual(await decodeBoard(tok), board);
});

test('2 photo bytes survive the binary tail unchanged', async () => {
  const bytes = randomBytes(24 * 1024);
  const c = { ...contrib, img: photo(bytes) };
  const back = await decodeContrib(await encodeContrib(c));
  equal(back.img, c.img);
  deepEqual(fromBase64url(toBase64url(bytes)), bytes);
});

test('3 a flipped bit in the token is rejected as broken', async () => {
  const tok = await encodeContrib(contrib);
  const bytes = fromBase64url(tok.slice(2));
  const zLen = new DataView(bytes.buffer).getUint32(0);
  // Flips inside the compressed data: without the zlib checksum most of them
  // would decode to a silently altered name or text.
  for (const k of [3, 4, 5]) {
    const b = bytes.slice();
    b[4 + Math.floor((zLen * k) / 8)] ^= 0x80;
    await rejects(decodeContrib('1.' + toBase64url(b)), { code: 'broken' }, `flip ${k}/8`);
  }
});

test('4 a truncated token is rejected as broken', async () => {
  const tok = await encodeContrib({ ...contrib, img: photo(randomBytes(4000, 3)) });
  ok(tok.length > 5000);
  await rejects(decodeContrib(tok.slice(0, tok.length - 40)), { code: 'broken' });
});

test('5 a newer version prefix is rejected before decompressing', async () => {
  const tok = await encodeInvite(board);
  const Orig = globalThis.DecompressionStream;
  let constructed = 0;
  globalThis.DecompressionStream = class extends Orig {
    constructor(...a) { constructed++; super(...a); }
  };
  try {
    await rejects(decodeInvite('9.' + tok.slice(2)), { code: 'version' });
    equal(constructed, 0);
    deepEqual(await decodeInvite(tok), { id: ID, title: board.title, preset: 'b', hue: 300 });
    equal(constructed, 1); // the spy is live
  } finally {
    globalThis.DecompressionStream = Orig;
  }
});

test('6 a decompression bomb is rejected by the size cap', async () => {
  const tok = await pack({ z: '0'.repeat(1 << 20) });
  ok(tok.length < 5000);
  await rejects(unpack(tok), { code: 'limit' });
});

test('7 validate rejects values outside the schema', () => {
  const entry = (o) => [o.name ?? 'A', o.text ?? 'B', o.sticker ?? '', o.img ?? ''];
  const good = [ID, 'T', 'p', 0, [entry({})]];
  deepEqual(validate('board', good), { id: ID, title: 'T', preset: 'p', hue: 0, contribs: [{ name: 'A', text: 'B', sticker: '', img: '' }] });
  const bad = [
    ['type: not an array', 'x'],
    ['type: hue as string', [ID, 'T', 'p', '0', []]],
    ['type: contrib entry short', [ID, 'T', 'p', 0, [['A', 'B']]]],
    ['name 61', [ID, 'T', 'p', 0, [entry({ name: 'x'.repeat(61) })]]],
    ['text 1001', [ID, 'T', 'p', 0, [entry({ text: 'x'.repeat(1001) })]]],
    ['title 81', [ID, 'x'.repeat(81), 'p', 0, []]],
    ['preset x', [ID, 'T', 'x', 0, []]],
    ['hue 360', [ID, 'T', 'p', 360, []]],
    ['501 contribs', [ID, 'T', 'p', 0, Array.from({ length: 501 }, () => entry({}))]],
    ['sticker 9 code points', [ID, 'T', 'p', 0, [entry({ sticker: '🎉'.repeat(9) })]]],
    ['http image', [ID, 'T', 'p', 0, [entry({ img: 'http://example.org/a.jpg' })]]],
    ['photo over limit', [ID, 'T', 'p', 0, [entry({ img: photo(randomBytes(LIMITS.photo + 1)) })]]],
    ['bad id', ['abc', 'T', 'p', 0, []]],
  ];
  equal(bad.length, 13);
  for (const [label, t] of bad) throws(() => validate('board', t), { code: 'invalid' }, label);
  throws(() => validate('contrib', [ID, 'A', 'B', '', 'javascript:alert(1)']), { code: 'invalid' });
  throws(() => validate('invite', [ID, 'T', 'p']), { code: 'invalid' });
});

test('8 chat export merge: wrapped, duplicate, foreign and broken tokens', async () => {
  const mk = (name, id = ID) => encodeContrib({ ...contrib, id, name });
  const [a, b, c, f] = await Promise.all([mk('Anna'), mk('Ben'), mk('Chris'), mk('Dora', 'zzzzzz')]);
  const wrap = (t) => t.slice(0, 30) + '\r\n' + t.slice(30, 55) + '\n ' + t.slice(55); // mail line wrap
  const text = [
    `[25.09.26, 12:01] Anna: Glückwunsch von Anna für „Oma“: https://x.test/#c=${a}`,
    `[25.09.26, 12:02] Ben: https://x.test/#c=${wrap(b)}`,
    'Liebe Grüße',
    `25.09.26, 12:03 - Chris: https://x.test/#c=${c}`,
    `[25.09.26, 12:04] Anna: nochmal https://x.test/#c=${a}`,
    `[25.09.26, 12:05] Dora: https://x.test/#c=${f}`,
    `[25.09.26, 12:06] Emil: https://x.test/#c=${b.slice(0, 30)}`,
  ].join('\n');
  const cands = extractContribs(text);
  equal(cands.length, 6);
  const target = { id: ID, title: 'T', preset: 'p', hue: 1, contribs: [] };
  deepEqual(await mergeContribs(target, cands), { added: 3, dupes: 1, foreign: 1, broken: 1 });
  deepEqual(target.contribs.map((e) => e.name), ['Anna', 'Ben', 'Chris']);
  // bare tokens without the #c= prefix are found too, short noise is not
  equal(extractContribs(`Version 1.2 und hier: ${a}`).length, 1);
  equal(addContrib(target, { ...contrib, name: 'Anna' }), 'dupes');
});

test('9 size budget: 50 text contributions and one photo contribution', async () => {
  const words = 'alles gute liebe oma wir wünschen dir gesundheit glück freude und viele schöne jahre bleib wie du bist danke für alles herzlichen glückwunsch zum geburtstag feier schön'.split(' ');
  const next = lcg(42);
  const sentence = () => {
    let s = '';
    while (s.length < 280) s += words[next() % words.length] + ' ';
    return s.slice(0, 280);
  };
  const big = {
    ...board, contribs: Array.from({ length: 50 }, (_, i) => ({
      name: `Person ${i}`, text: sentence(), sticker: i % 3 ? '🎉' : '', img: '',
    })),
  };
  equal(big.contribs.length, 50);
  const tok = await encodeBoard(big);
  ok(tok.length <= 12_000, `board token is ${tok.length} chars`);
  const withPhoto = await encodeContrib({ ...contrib, img: photo(randomBytes(24 * 1024, 9)) });
  ok(withPhoto.length <= 34_000, `photo token is ${withPhoto.length} chars`);
});

test('10 mergeText: chat export starting with "[" is not a backup, real backup is a union', async () => {
  const tok = await encodeContrib(contrib);
  const target = { id: ID, title: 'T', preset: 'p', hue: 1, contribs: [] };
  const chat = `[25.09.26, 12:01] Anna: https://x.test/#c=${tok}\n[25.09.26, 12:02] Ben: [Bild weggelassen]`;
  deepEqual(await mergeText(target, chat), { added: 1, dupes: 0, foreign: 0, broken: 0 });
  const backup = JSON.stringify(toTuple('board', board));
  ok(backup.startsWith('['));
  deepEqual(await mergeText(target, backup), { added: 3, dupes: 0, foreign: 0, broken: 0 });
  deepEqual(await mergeText(target, backup), { added: 0, dupes: 3, foreign: 0, broken: 0 });
  deepEqual(await mergeText(target, '[1, 2, 3]'), { added: 0, dupes: 0, foreign: 0, broken: 1 });
  equal(target.contribs.length, 4);
});

// A 32 × 24 test image: dark left half, light right half, red square.
function testImage() {
  const w = 32, h = 24, rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      const red = x >= 20 && x < 28 && y >= 4 && y < 12;
      rgba.set(red ? [220, 30, 30, 255] : x < 16 ? [20, 20, 40, 255] : [240, 240, 220, 255], p);
    }
  }
  return { rgba, w, h };
}
// Paints a sketch the way the SVG does (pixel centres, alpha 0.5, no blur)
// and returns the mean absolute error against the image.
function sketchError(bytes, { rgba, w, h }) {
  const cur = [];
  for (let i = 0; i < w * h; i++) cur.push([bytes[2], bytes[3], bytes[4]]);
  const side = (ax, ay, bx, by, px, py) => (bx - ax) * (py - ay) - (by - ay) * (px - ax);
  for (let o = 5; o < bytes.length; o += 9) {
    const [x1, y1, x2, y2, x3, y3, r, g, b] = bytes.subarray(o, o + 9);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const d = [side(x1, y1, x2, y2, x + 0.5, y + 0.5), side(x2, y2, x3, y3, x + 0.5, y + 0.5), side(x3, y3, x1, y1, x + 0.5, y + 0.5)];
        if (!(d.every((v) => v >= 0) || d.every((v) => v <= 0))) continue;
        const c = cur[y * w + x];
        [r, g, b].forEach((v, k) => { c[k] += 0.5 * (v - c[k]); });
      }
    }
  }
  let err = 0;
  cur.forEach((c, i) => c.forEach((v, k) => { err += Math.abs(v - rgba[i * 4 + k]); }));
  return err / (w * h * 3);
}

test('11 sketch fit: error falls well below the flat background, deterministic, prefixes valid', async () => {
  const img = testImage();
  const bytes = await sketch(img.rgba, img.w, img.h, { shapes: 40 });
  equal(bytes.length, 5 + 9 * 40);
  ok(isSketch(bytes));
  const flat = sketchError(trimSketch(bytes, 0), img);
  const fitted = sketchError(bytes, img);
  ok(fitted < flat * 0.4, `error ${fitted.toFixed(1)} vs flat ${flat.toFixed(1)}`);
  // the best of the random candidates alone, without hill climbing, already helps
  const rough = sketchError(await sketch(img.rgba, img.w, img.h, { shapes: 40, patience: 0 }), img);
  ok(rough < flat * 0.8, `random-only error ${rough.toFixed(1)} vs flat ${flat.toFixed(1)}`);
  deepEqual(await sketch(img.rgba, img.w, img.h, { shapes: 40 }), bytes);
  ok(isSketch(trimSketch(bytes, 7)) && shapeCount(trimSketch(bytes, 7)) === 7);
});

test('12 sketches ride in the tail, stay small, and render as SVG from numbers only', async () => {
  const img = testImage();
  const bytes = await sketch(img.rgba, img.w, img.h, { shapes: 120 });
  const c = { ...contrib, text: 'x'.repeat(280), img: sketchImg(bytes) };
  const tok = await encodeContrib(c);
  deepEqual(await decodeContrib(tok), c);
  ok(tok.length <= 1800, `sketch token is ${tok.length} chars`);
  const { obj, tail } = await unpack(tok);
  equal(obj[4], -bytes.length);
  deepEqual(tail, bytes);
  const b = { ...board, contribs: [{ ...board.contribs[0], img: sketchImg(bytes) }, { ...board.contribs[1], img: photo(randomBytes(900)) }] };
  deepEqual(await decodeBoard(await encodeBoard(b)), b);
  const src = imgSrc(c.img);
  ok(src.startsWith('data:image/svg+xml;base64,'));
  const svg = atob(src.slice(src.indexOf(',') + 1));
  equal(svg, sketchSvg(bytes));
  ok(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"[^<]*>(<\/?(filter|feGaussianBlur|rect|g|path)( [a-zA-Z-]+="[#0-9a-zA-Z. ()]*")*\/?>)+<\/svg>$/.test(svg), svg.slice(0, 200));
  equal(imgSrc('https://example.org/p.jpg'), 'https://example.org/p.jpg');
});

test('13 malformed sketches are rejected', () => {
  const good = Uint8Array.from([10, 8, 1, 2, 3, 0, 0, 10, 0, 5, 8, 9, 9, 9]);
  ok(isSketch(good));
  const bad = [
    ['x beyond w', [10, 8, 1, 2, 3, 11, 0, 10, 0, 5, 8, 9, 9, 9]],
    ['y beyond h', [10, 8, 1, 2, 3, 0, 0, 10, 0, 5, 9, 9, 9, 9]],
    ['zero width', [0, 8, 1, 2, 3]],
    ['partial shape', [10, 8, 1, 2, 3, 0, 0, 10]],
    ['too many shapes', [10, 8, 1, 2, 3, ...new Array(9 * (MAX_SHAPES + 1)).fill(0)]],
  ];
  for (const [label, arr] of bad) {
    equal(isSketch(Uint8Array.from(arr)), false, label);
    throws(() => sketchSvg(Uint8Array.from(arr)), label);
    throws(() => validate('contrib', [ID, 'A', 'B', '', sketchImg(Uint8Array.from(arr))]), { code: 'invalid' }, label);
  }
  deepEqual(validate('contrib', [ID, 'A', 'B', '', sketchImg(good)]).img, sketchImg(good));
  throws(() => validate('contrib', [ID, 'A', 'B', '', 'sketch:A']), { code: 'invalid' });
  throws(() => validate('contrib', [ID, 'A', 'B', '', -(LIMITS.sketch + 1)]), { code: 'invalid' });
});

test('14 version 1 tokens (JPEG photos) are still read', async () => {
  const c = { ...contrib, img: photo(randomBytes(2000, 5)) };
  const tok = await encodeContrib(c);
  deepEqual(await decodeContrib('1.' + tok.slice(2)), c);
  await rejects(decodeContrib('3.' + tok.slice(2)), { code: 'version' });
  deepEqual(extractContribs(`https://x.test/#c=1.${tok.slice(2)}`), ['1.' + tok.slice(2)]);
});

test('15 extractor: no candidates from ordinary text, back-to-back bare tokens, no #i=/#b=', async () => {
  const [a, b] = await Promise.all([encodeContrib(contrib), encodeContrib({ ...contrib, name: 'Ben' })]);
  equal(extractContribs('1. November 2026 feiern wir alle zusammen bei Oma im Garten, ab 15 Uhr.').length, 0);
  equal(extractContribs('Treffpunkt: 2.Advent danach gemeinsam zum Weihnachtsmarkt am alten Rathaus').length, 0);
  equal(extractContribs('siehe Tabelle 1.AAB unten').length, 0);
  deepEqual(extractContribs(`${a} ${b}`), [a, b]);
  deepEqual(extractContribs(`https://x.test/#c=${a}\n2. Absatz`), [a]);
  const inv = await encodeInvite(board);
  const adm = await encodeBoard(board);
  deepEqual(extractContribs(`https://x.test/#i=${inv} https://x.test/#b=${adm} https://x.test/#c=${a}`), [a]);
});
