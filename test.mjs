// SPDX-License-Identifier: GPL-3.0-or-later
// Run: node --test test.mjs
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { deepEqual, equal, ok, rejects, throws } from 'node:assert/strict';
import {
  LIMITS, addContrib, decodeBoard, decodeContrib, decodeInvite, encodeBoard,
  encodeContrib, encodeInvite, extractContribs, fromBase64, fromBase64url, imgSrc,
  deletePost, mergeBoard, mergeContribs, mergeText, originOf, pack, sketchImg, toBase64, toBase64url, toTuple, unpack, validate,
} from './codec.js';
import { MAX_SHAPES, isSketch, sketchSvg } from './sketch.js';
import { encodeJpeg, jpegHeader, ssim, strippedLength, stripJpeg, unstripJpeg } from './jpeg.js';

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
// A board as validate() returns it: every post with its origin, a deleted list.
const posts = (b) => ({ ...b, contribs: b.contribs.map((c) => ({ ...c, origin: c.origin ?? originOf(c) })), deleted: b.deleted ?? [] });

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
  ok(tok.startsWith('3.'));
  deepEqual(await decodeBoard(tok), posts(board));
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
  deepEqual(validate('board', good), posts({ id: ID, title: 'T', preset: 'p', hue: 0, contribs: [{ name: 'A', text: 'B', sticker: '', img: '' }] }));
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
  deepEqual(await mergeContribs(target, cands), { added: 3, dupes: 1, foreign: 1, broken: 1, full: 0 });
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
  deepEqual(await mergeText(target, chat), { added: 1, dupes: 0, foreign: 0, broken: 0, full: 0 });
  const backup = JSON.stringify(toTuple('board', board));
  ok(backup.startsWith('['));
  deepEqual(await mergeText(target, backup), { added: 3, dupes: 0, foreign: 0, broken: 0, full: 0, removed: 0 });
  deepEqual(await mergeText(target, backup), { added: 0, dupes: 3, foreign: 0, broken: 0, full: 0, removed: 0 });
  deepEqual(await mergeText(target, '[1, 2, 3]'), { added: 0, dupes: 0, foreign: 0, broken: 1, full: 0 });
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
// A valid sketch (version 2 format) of n triangles on a 32 × 24 grid.
function fakeSketch(n, seed = 3) {
  const next = lcg(seed);
  const out = [32, 24, 120, 130, 140];
  for (let i = 0; i < n; i++) out.push(next() % 33, next() % 25, next() % 33, next() % 25, next() % 33, next() % 25, next() & 255, next() & 255, next() & 255);
  return Uint8Array.from(out);
}

test('12 version 2 sketches still ride in the tail and render as SVG from numbers only', async () => {
  const bytes = fakeSketch(120);
  const c = { ...contrib, text: 'x'.repeat(280), img: sketchImg(bytes) };
  const tok = await encodeContrib(c);
  deepEqual(await decodeContrib(tok), c);
  ok(tok.length <= 1800, `sketch token is ${tok.length} chars`);
  const { obj, tail } = await unpack(tok);
  equal(obj[4], -bytes.length);
  deepEqual(tail, bytes);
  const b = { ...board, contribs: [{ ...board.contribs[0], img: sketchImg(bytes) }, { ...board.contribs[1], img: photo(randomBytes(900)) }] };
  deepEqual(await decodeBoard(await encodeBoard(b)), posts(b));
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

test('14 version 1 and 2 tokens are still read', async () => {
  const c = { ...contrib, img: photo(randomBytes(2000, 5)) };
  const tok = await encodeContrib(c);
  deepEqual(await decodeContrib('1.' + tok.slice(2)), c);
  const sk = { ...contrib, img: sketchImg(fakeSketch(4)) };
  deepEqual(await decodeContrib('2.' + (await encodeContrib(sk)).slice(2)), sk);
  await rejects(decodeContrib('4.' + tok.slice(2)), { code: 'version' });
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

test('16 mergeText: JSON that is no backup is searched for links (Telegram export)', async () => {
  const [a, b] = await Promise.all([encodeContrib(contrib), encodeContrib({ ...contrib, name: 'Ben' })]);
  const target = { id: ID, title: 'T', preset: 'p', hue: 1, contribs: [] };
  const telegram = JSON.stringify({ name: 'Oma 80', messages: [
    { from: 'Anna', text: `Glückwunsch von Anna: https:\/\/x.test\/#c=${a}` },
    { from: 'Ben', text: ['Hier: ', { type: 'link', text: `https://x.test/#c=${b}` }] },
  ] });
  deepEqual(await mergeText(target, telegram), { added: 2, dupes: 0, foreign: 0, broken: 0, full: 0 });
  deepEqual(target.contribs.map((e) => e.name), ['Anna', 'Ben']);
});

test('17 a full board counts the rest instead of throwing', async () => {
  const target = { id: ID, title: 'T', preset: 'p', hue: 1, contribs: Array.from({ length: LIMITS.contribs - 1 }, (_, i) => ({ name: `P${i}`, text: 'x', sticker: '', img: '' })) };
  const toks = await Promise.all(['Anna', 'Ben', 'Cleo'].map((name) => encodeContrib({ ...contrib, name })));
  deepEqual(await mergeContribs(target, toks), { added: 1, dupes: 0, foreign: 0, broken: 0, full: 2 });
  equal(target.contribs.length, LIMITS.contribs);
  equal(addContrib(target, { ...contrib, name: 'Dora' }), 'full');
  equal(addContrib(target, { ...contrib, name: 'Anna' }), 'dupes');
  const other = { ...target, contribs: [{ name: 'Emil', text: 'y', sticker: '', img: '' }] };
  deepEqual(mergeBoard(target, other), { added: 0, dupes: 0, foreign: 0, full: 1, removed: 0 });
});

test('18 photo boards, exact limits, and no foreign SVG', async () => {
  const sk = sketchImg(fakeSketch(5));
  const b = { ...board, contribs: [
    { name: 'A', text: 'a', sticker: '', img: photo(randomBytes(3000, 1)) },
    { name: 'B', text: 'b', sticker: '', img: '' },
    { name: 'C', text: 'c', sticker: '', img: sk },
    { name: 'D', text: 'd', sticker: '', img: photo(randomBytes(5000, 2)) },
    { name: 'E', text: 'e', sticker: '', img: 'https://example.org/e.jpg' },
  ] };
  deepEqual(await decodeBoard(await encodeBoard(b)), posts(b));
  const full = ['n'.repeat(LIMITS.name), 't'.repeat(LIMITS.text), '🎉'.repeat(LIMITS.sticker), ''];
  const max = [ID, 'x'.repeat(LIMITS.title), 'p', 359, Array.from({ length: LIMITS.contribs }, () => full)];
  equal(validate('board', max).contribs.length, LIMITS.contribs);
  ok(validate('contrib', [ID, 'A', 'B', '', photo(randomBytes(LIMITS.photo, 4))]));
  const svg = 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  throws(() => validate('contrib', [ID, 'A', 'B', '', svg]), { code: 'invalid' });
});

test('19 byte counts are wire-only: a backup with a numeric image is no backup', async () => {
  for (const n of [-5, 5]) {
    throws(() => validate('board', [ID, 'T', 'p', 1, [['M', 'hi', '', n]]]), { code: 'invalid' }, String(n));
    throws(() => validate('contrib', [ID, 'M', 'hi', '', n]), { code: 'invalid' }, String(n));
    ok(validate('contrib', [ID, 'M', 'hi', '', n], { wire: true }));
  }
  const target = { id: ID, title: 'T', preset: 'p', hue: 1, contribs: [] };
  deepEqual(await mergeText(target, JSON.stringify([ID, 'x', 'p', 1, [['M', 'hi', '', -5]]])), { added: 0, dupes: 0, foreign: 0, broken: 1, full: 0 });
  equal(target.contribs.length, 0);
});

test('20 own JPEGs travel without header and come back byte for byte', () => {
  const { rgba } = testImage();
  for (const [w, h, q] of [[32, 24, 30], [1, 1, 1], [17, 9, 100], [255, 3, 50]]) {
    const px = new Uint8Array(w * h * 4).map((_, i) => rgba[i % rgba.length]);
    const jpeg = encodeJpeg(px, w, h, q);
    deepEqual(jpeg.subarray(0, jpegHeader(w, h, q).length), jpegHeader(w, h, q), `${w}x${h} q${q}`);
    const small = stripJpeg(jpeg);
    deepEqual([...small.subarray(0, 4)], [1, q, w, h]);
    equal(small.length, strippedLength(jpeg));
    equal(jpeg.length - small.length, 589 - 2, 'the whole header but 4 bytes is saved');
    deepEqual(unstripJpeg(small), jpeg);
  }
  // The header is part of the link format: links saved today must decode
  // tomorrow, so the tables may never change.
  const pin = createHash('sha256');
  for (let q = 1; q <= 100; q++) pin.update(jpegHeader(1, 1, q));
  equal(pin.digest('hex'), '39e4c47352b85134cac9e07698faa567e07688a3b367a936d4774dcdfb3eec98');
  throws(() => encodeJpeg(new Uint8Array(4 * 256), 256, 1, 50), RangeError);
  throws(() => encodeJpeg(new Uint8Array(4), 1, 1, 0), RangeError);
});

test('21 foreign JPEGs keep their header; malformed stripped bytes are refused', () => {
  const { rgba, w, h } = testImage();
  const jpeg = encodeJpeg(rgba, w, h, 40);
  for (const [label, at] of [['quantisation table', 20], ['Huffman table', 300], ['scan header', 580]]) {
    const other = jpeg.slice();
    other[at] ^= 1;
    equal(stripJpeg(other), null, label);
  }
  equal(stripJpeg(jpeg.subarray(0, jpeg.length - 1)), null, 'no end marker');
  const wide = new Uint8Array([...jpegHeader(300, 10, 40), 1, 2, 3, 0xff, 0xd9]);
  equal(stripJpeg(wide), null, 'width does not fit in a byte');
  equal(stripJpeg(randomBytes(900)), null, 'random bytes');
  const small = stripJpeg(jpeg);
  for (const [label, patch] of [['type', [0]], ['quality 0', [1, 0]], ['quality 101', [1, 101]], ['width 0', [1, 40, 0]], ['height 0', [1, 40, 32, 0]]]) {
    const bad = small.slice();
    bad.set(patch);
    equal(unstripJpeg(bad), null, label);
  }
});

test('22 photos on the wire: own JPEG without header, legacy JPEG as is', async () => {
  const { rgba, w, h } = testImage();
  const jpeg = encodeJpeg(rgba, w, h, 30);
  const c = { ...contrib, text: 'x'.repeat(280), img: 'data:image/jpeg;base64,' + toBase64(jpeg) };
  const tok = await encodeContrib(c);
  ok(tok.startsWith('3.'));
  const { obj, tail } = await unpack(tok);
  equal(obj[4], strippedLength(jpeg));
  deepEqual(tail, stripJpeg(jpeg));
  deepEqual(await decodeContrib(tok), c);
  const legacy = { ...contrib, img: photo(randomBytes(3000, 8)) };
  equal((await unpack(await encodeContrib(legacy))).tail.length, 3000);
  deepEqual(await decodeContrib(await encodeContrib(legacy)), legacy);
  // a stripped photo with an impossible header field is a broken link
  const bad = tail.slice();
  bad[1] = 0;
  await rejects(decodeContrib(await pack(obj, [bad])), { code: 'broken' });
});

test('23 ssim: 1 for identical images, lower the more they differ', () => {
  const { rgba, w, h } = testImage();
  equal(ssim(rgba, rgba, w, h), 1);
  const noisy = rgba.map((v, i) => (i % 4 === 3 ? v : Math.max(0, Math.min(255, v + ((i * 37) % 41) - 20))));
  const inverted = rgba.map((v, i) => (i % 4 === 3 ? v : 255 - v));
  const sNoisy = ssim(rgba, noisy, w, h);
  const sInv = ssim(rgba, inverted, w, h);
  ok(sNoisy < 1 && sNoisy > 0.5, `noisy ${sNoisy}`);
  ok(sInv < sNoisy && sInv < 0.2, `inverted ${sInv}`);
});

test('24 boards from before version 3 get origins; origins and deletions survive a round trip', async () => {
  const legacy = [ID, 'T', 'p', 1, [['Anna', 'Hallo', '', ''], ['Ben', 'Hi', '🎉', '']]];
  const b = validate('board', legacy);
  deepEqual(b.contribs.map((e) => e.origin), [originOf({ name: 'Anna', text: 'Hallo', sticker: '', img: '' }), originOf({ name: 'Ben', text: 'Hi', sticker: '🎉', img: '' })]);
  deepEqual(b.deleted, []);
  // origins are stored in boards: the hash may never change
  equal(b.contribs[0].origin, 'P5eHa8Et');
  b.contribs[0].text = 'Hallo, bearbeitet';
  deletePost(b, b.contribs[1].origin);
  const t = toTuple('board', b);
  equal(t.length, 6);
  equal(t[4][0][4], originOf({ name: 'Anna', text: 'Hallo', sticker: '', img: '' }), 'an edit keeps the origin');
  deepEqual(await decodeBoard(await encodeBoard(b)), b);
  deepEqual(validate('board', JSON.parse(JSON.stringify(t))), b);
  for (const bad of [[...t.slice(0, 5), ['x']], [...t.slice(0, 5), 'x'], [...t.slice(0, 4), [['A', 'B', '', '', 'short']], []], [...t, []], [...t.slice(0, 5), new Array(LIMITS.deleted + 1).fill('AAAAAAAA')]]) {
    throws(() => validate('board', bad), { code: 'invalid' });
  }
  // an edited photo post keeps its origin through the photo tail
  const { rgba, w, h } = testImage();
  const withPhoto = validate('board', [ID, 'T', 'p', 1, [['Cleo', 'Foto', '', 'data:image/jpeg;base64,' + toBase64(encodeJpeg(rgba, w, h, 30))]]]);
  const photoOrigin = withPhoto.contribs[0].origin;
  withPhoto.contribs[0].text = 'Foto, bearbeitet';
  equal((await decodeBoard(await encodeBoard(withPhoto))).contribs[0].origin, photoOrigin);
  // a board object without a deleted list (created before version 3) still records deletions
  const lone = { id: ID, title: 'T', preset: 'p', hue: 1, contribs: [{ ...withPhoto.contribs[0] }] };
  deletePost(lone, photoOrigin);
  deepEqual([lone.contribs.length, lone.deleted], [0, [photoOrigin]]);
  // the deleted list keeps the newest LIMITS.deleted origins
  const many = { ...b, deleted: Array.from({ length: LIMITS.deleted }, (_, i) => `x${String(i).padStart(7, '0')}`) };
  deletePost(many, 'newest00');
  equal(many.deleted.length, LIMITS.deleted);
  equal(many.deleted.at(-1), 'newest00');
  equal(many.deleted[0], 'x0000001');
});

test('25 merging the same links again does not bring back deleted or duplicate edited posts', async () => {
  const toks = await Promise.all(['Anna', 'Ben', 'Cleo'].map((name) => encodeContrib({ ...contrib, name, text: `Gruß von ${name}` })));
  const b = { id: ID, title: 'T', preset: 'p', hue: 1, contribs: [], deleted: [] };
  deepEqual(await mergeContribs(b, toks), { added: 3, dupes: 0, foreign: 0, broken: 0, full: 0 });
  b.contribs[0].text = 'Gruß von Anna, korrigiert';
  b.contribs[2].img = '';
  deletePost(b, b.contribs[1].origin);
  deepEqual(await mergeContribs(b, toks), { added: 0, dupes: 3, foreign: 0, broken: 0, full: 0 });
  deepEqual(b.contribs.map((e) => [e.name, e.text]), [['Anna', 'Gruß von Anna, korrigiert'], ['Cleo', 'Gruß von Cleo']]);
  equal(addContrib(b, { ...contrib, name: 'Ben', text: 'Gruß von Ben' }), 'dupes');
});

test('26 two copies of a board: deletions travel, local edits win, new posts arrive', async () => {
  const toks = await Promise.all(['Anna', 'Ben', 'Cleo'].map((name) => encodeContrib({ ...contrib, name, text: `Gruß von ${name}` })));
  const a = { id: ID, title: 'T', preset: 'p', hue: 1, contribs: [], deleted: [] };
  await mergeContribs(a, toks.slice(0, 2));
  const b = await decodeBoard(await encodeBoard(a)); // admin link to a second device
  b.contribs[0].text = 'Anna, auf B bearbeitet';
  deletePost(b, b.contribs[1].origin); // Ben deleted on B
  await mergeContribs(b, toks.slice(2)); // Cleo arrived on B
  a.contribs[0].text = 'Anna, auf A bearbeitet';
  deepEqual(mergeBoard(a, b), { added: 1, dupes: 1, foreign: 0, full: 0, removed: 1 });
  deepEqual(a.contribs.map((e) => [e.name, e.text]), [['Anna', 'Anna, auf A bearbeitet'], ['Cleo', 'Gruß von Cleo']]);
  deepEqual(a.deleted, b.deleted);
  deepEqual(mergeBoard(b, a), { added: 0, dupes: 2, foreign: 0, full: 0, removed: 0 });
  equal(mergeBoard(a, { ...b, id: 'zzzzzz' }).foreign, 2);
});
