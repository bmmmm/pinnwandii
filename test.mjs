// SPDX-License-Identifier: GPL-3.0-or-later
// Run: node --test test.mjs
import { test } from 'node:test';
import { deepEqual, equal, ok, rejects, throws } from 'node:assert/strict';
import {
  LIMITS, addContrib, decodeBoard, decodeContrib, decodeInvite, encodeBoard,
  encodeContrib, encodeInvite, extractContribs, fromBase64url, mergeContribs,
  pack, toBase64, toBase64url, unpack, validate,
} from './codec.js';

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
  ok(tok.startsWith('1.'));
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
