// SPDX-License-Identifier: GPL-3.0-or-later
// URL token codec for pinnwandii: JSON tuples + zlib + base64url with a raw
// binary tail for photos. Pure ESM without DOM access; runs in Node >= 21.2
// and in browsers. Every rejection throws a CodecError whose `code` is one of
// 'version' (token from a newer app), 'broken' (corrupt or truncated),
// 'limit' (too large) or 'invalid' (content outside the schema).
//
// Wire format:  "<version>." + base64url( u32be(zlibLen) ++ zlib(json) ++ bins… )
//   invite  = [id, title, preset, hue]
//   contrib = [id, name, text, sticker, img]
//   board   = [id, title, preset, hue, [[name, text, sticker, img], …]]
//   img     = "" | "https://…" | <number: byte length of a photo in the tail>
// In memory and in storage photos are data URIs; toTuple()/validate() convert
// between tuples and plain objects.

export const VERSION = '1';
export const PRESETS = ['p', 'b', 'd'];
export const LIMITS = Object.freeze({
  title: 80, name: 60, text: 1000, sticker: 8, url: 500,
  photo: 28 * 1024, contribs: 500, token: 200_000,
  json: 512 * 1024, tail: 4 * 1024 * 1024,
});

export class CodecError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CodecError';
    this.code = code;
  }
}
const fail = (code, message) => { throw new CodecError(code, message); };
export const MESSAGES = Object.freeze({
  version: 'Der Link stammt aus einer neueren Version. Bitte die Seite neu laden.',
  broken: 'Link beschädigt oder unvollständig, oft beim Kopieren abgeschnitten.',
  limit: 'Der Inhalt ist zu groß.',
});

// ---- base64 -----------------------------------------------------------------

function bytesToBinary(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return s;
}
export const toBase64 = (bytes) => btoa(bytesToBinary(bytes));
export const toBase64url = (bytes) =>
  toBase64(bytes).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');

export function fromBase64(str) {
  let bin;
  try { bin = atob(str); } catch { fail('broken', MESSAGES.broken); }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export function fromBase64url(str) {
  if (!/^[A-Za-z0-9_-]*$/.test(str) || str.length % 4 === 1) fail('broken', MESSAGES.broken);
  const b64 = str.replaceAll('-', '+').replaceAll('_', '/');
  return fromBase64(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
}

// ---- zlib via the Compression Streams API ---------------------------------

function streamOf(bytes) {
  // Copy: some implementations detach the chunk's buffer, and callers pass
  // subarray views that share their buffer with the photo tail.
  const chunk = bytes.slice();
  return new ReadableStream({ start(c) { c.enqueue(chunk); c.close(); } });
}
async function readAll(stream, cap) {
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > cap) {
      await reader.cancel().catch(() => {});
      fail('limit', MESSAGES.limit);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}
const deflate = (bytes) =>
  readAll(streamOf(bytes).pipeThrough(new CompressionStream('deflate')), Infinity);
async function inflate(bytes, cap) {
  try {
    return await readAll(streamOf(bytes).pipeThrough(new DecompressionStream('deflate')), cap);
  } catch (e) {
    if (e instanceof CodecError) throw e;
    fail('broken', MESSAGES.broken);
  }
}

// ---- container --------------------------------------------------------------

export async function pack(obj, bins = []) {
  const z = await deflate(new TextEncoder().encode(JSON.stringify(obj)));
  const tailLen = bins.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(4 + z.length + tailLen);
  new DataView(out.buffer).setUint32(0, z.length);
  out.set(z, 4);
  let off = 4 + z.length;
  for (const b of bins) { out.set(b, off); off += b.length; }
  return VERSION + '.' + toBase64url(out);
}

export async function unpack(str) {
  if (typeof str !== 'string') fail('broken', MESSAGES.broken);
  if (str.length > LIMITS.token) fail('limit', MESSAGES.limit);
  const dot = str.indexOf('.');
  const ver = dot > 0 ? str.slice(0, dot) : '';
  if (!/^\d+$/.test(ver)) fail('broken', MESSAGES.broken);
  // Version gate first: a newer token is never fed to the decompressor.
  if (ver !== VERSION) {
    const code = Number(ver) > Number(VERSION) ? 'version' : 'broken';
    fail(code, MESSAGES[code]);
  }
  const bytes = fromBase64url(str.slice(dot + 1));
  if (bytes.length < 4) fail('broken', MESSAGES.broken);
  const zLen = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
  if (4 + zLen > bytes.length) fail('broken', MESSAGES.broken);
  const tail = bytes.subarray(4 + zLen);
  if (tail.length > LIMITS.tail) fail('limit', MESSAGES.limit);
  const json = await inflate(bytes.subarray(4, 4 + zLen), LIMITS.json);
  let obj;
  try {
    obj = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(json));
  } catch {
    fail('broken', MESSAGES.broken);
  }
  return { obj, tail };
}

// ---- schema -----------------------------------------------------------------

const ID_RE = /^[A-Za-z0-9_-]{6}$/;
const URL_RE = /^https:\/\/\S+$/;
const DATA_RE = /^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/;
const isStr = (v, max, min = 1) => typeof v === 'string' && v.length >= min && v.length <= max;
const dataUriBytes = (b64) =>
  Math.floor((b64.length * 3) / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);

function checkImg(img) {
  if (img === '') return;
  if (typeof img === 'number') {
    if (Number.isInteger(img) && img > 0 && img <= LIMITS.photo) return;
    fail('invalid', 'Foto zu groß.');
  }
  if (typeof img !== 'string') fail('invalid', 'Bild: falscher Typ.');
  if (URL_RE.test(img) && img.length <= LIMITS.url) return;
  const m = DATA_RE.exec(img);
  if (m && dataUriBytes(m[1]) <= LIMITS.photo) return;
  fail('invalid', 'Bild muss ein https-Link oder ein kleines Foto sein.');
}
function checkEntry(t) {
  if (!Array.isArray(t) || t.length !== 4) fail('invalid', 'Beitrag: falscher Typ.');
  const [name, text, sticker, img] = t;
  if (!isStr(name, LIMITS.name)) fail('invalid', `Name: 1 bis ${LIMITS.name} Zeichen.`);
  if (!isStr(text, LIMITS.text)) fail('invalid', `Text: 1 bis ${LIMITS.text} Zeichen.`);
  if (typeof sticker !== 'string' || [...sticker].length > LIMITS.sticker) fail('invalid', 'Sticker: zu lang.');
  checkImg(img);
  return { name, text, sticker, img };
}
function checkHead(t, len) {
  if (!Array.isArray(t) || t.length !== len) fail('invalid', 'Falscher Typ.');
  const [id, title, preset, hue] = t;
  if (typeof id !== 'string' || !ID_RE.test(id)) fail('invalid', 'Kennung ungültig.');
  if (!isStr(title, LIMITS.title)) fail('invalid', `Titel: 1 bis ${LIMITS.title} Zeichen.`);
  if (!PRESETS.includes(preset)) fail('invalid', 'Farbwelt unbekannt.');
  if (!Number.isInteger(hue) || hue < 0 || hue > 359) fail('invalid', 'Farbton außerhalb 0–359.');
  return { id, title, preset, hue };
}

/** Validates a tuple of the given kind and returns it as a plain object. */
export function validate(kind, t) {
  if (kind === 'invite') return checkHead(t, 4);
  if (kind === 'board') {
    const b = checkHead(t, 5);
    if (!Array.isArray(t[4])) fail('invalid', 'Beiträge: falscher Typ.');
    if (t[4].length > LIMITS.contribs) fail('invalid', `Höchstens ${LIMITS.contribs} Beiträge.`);
    b.contribs = t[4].map(checkEntry);
    return b;
  }
  if (kind === 'contrib') {
    if (!Array.isArray(t) || t.length !== 5) fail('invalid', 'Beitrag: falscher Typ.');
    if (typeof t[0] !== 'string' || !ID_RE.test(t[0])) fail('invalid', 'Kennung ungültig.');
    return { id: t[0], ...checkEntry(t.slice(1)) };
  }
  throw new Error(`unknown kind: ${kind}`);
}

export function toTuple(kind, o) {
  if (kind === 'invite') return [o.id, o.title, o.preset, o.hue];
  if (kind === 'contrib') return [o.id, o.name, o.text, o.sticker, o.img];
  if (kind === 'board') {
    return [o.id, o.title, o.preset, o.hue, o.contribs.map((c) => [c.name, c.text, c.sticker, c.img])];
  }
  throw new Error(`unknown kind: ${kind}`);
}

export function newId() {
  return toBase64url(crypto.getRandomValues(new Uint8Array(6))).slice(0, 6);
}

// ---- photos: data URIs <-> binary tail --------------------------------------

function splitPhotos(entries) {
  const bins = [];
  const wired = entries.map(([name, text, sticker, img]) => {
    if (!img.startsWith('data:')) return [name, text, sticker, img];
    const bytes = fromBase64(img.slice(img.indexOf(',') + 1));
    bins.push(bytes);
    return [name, text, sticker, bytes.length];
  });
  return [wired, bins];
}
function joinPhotos(entries, tail) {
  let off = 0;
  const out = entries.map(([name, text, sticker, img]) => {
    if (typeof img !== 'number') return [name, text, sticker, img];
    const bytes = tail.subarray(off, off + img);
    off += img;
    return [name, text, sticker, 'data:image/jpeg;base64,' + toBase64(bytes)];
  });
  if (off !== tail.length) fail('broken', MESSAGES.broken);
  return out;
}

// ---- public encode / decode -------------------------------------------------

export async function encodeInvite(inv) {
  const t = toTuple('invite', inv);
  validate('invite', t);
  return pack(t);
}
export async function decodeInvite(str) {
  const { obj, tail } = await unpack(str);
  if (tail.length) fail('broken', MESSAGES.broken);
  return validate('invite', obj);
}

export async function encodeContrib(c) {
  const t = toTuple('contrib', c);
  validate('contrib', t);
  const [[entry], bins] = splitPhotos([t.slice(1)]);
  return pack([t[0], ...entry], bins);
}
export async function decodeContrib(str) {
  const { obj, tail } = await unpack(str);
  validate('contrib', obj);
  const [entry] = joinPhotos([obj.slice(1)], tail);
  return validate('contrib', [obj[0], ...entry]);
}

export async function encodeBoard(b) {
  const t = toTuple('board', b);
  validate('board', t);
  const [wired, bins] = splitPhotos(t[4]);
  return pack([...t.slice(0, 4), wired], bins);
}
export async function decodeBoard(str) {
  const { obj, tail } = await unpack(str);
  validate('board', obj);
  return validate('board', [...obj.slice(0, 4), joinPhotos(obj[4], tail)]);
}

// ---- merging ----------------------------------------------------------------

const sameEntry = (a, b) =>
  a.name === b.name && a.text === b.text && a.sticker === b.sticker && a.img === b.img;

/** Adds one contribution to a board; returns 'added' | 'dupes' | 'foreign'. */
export function addContrib(board, c) {
  if (c.id !== board.id) return 'foreign';
  if (board.contribs.some((e) => sameEntry(e, c))) return 'dupes';
  if (board.contribs.length >= LIMITS.contribs) fail('limit', `Höchstens ${LIMITS.contribs} Beiträge.`);
  board.contribs.push({ name: c.name, text: c.text, sticker: c.sticker, img: c.img });
  return 'added';
}

/** Union of two boards' contributions (into `board`). */
export function mergeBoard(board, other) {
  const r = { added: 0, dupes: 0, foreign: 0 };
  for (const e of other.contribs) r[addContrib(board, { id: other.id, ...e })]++;
  return r;
}

// Token runs may contain whitespace: mail clients wrap long lines. The run is
// kept as whitespace-separated segments so the merge can drop trailing
// segments that turn out to be ordinary text following the link.
const TOKEN_RE = /#c=1\.([A-Za-z0-9_\-\s]+)|(?<![A-Za-z0-9_\-.=#])1\.([A-Za-z0-9_\-\s]+)/g;

/** Finds contribution token candidates in free text (chat exports, mails). */
export function extractContribs(text) {
  const out = [];
  for (const m of text.matchAll(TOKEN_RE)) {
    const segs = (m[1] ?? m[2]).trim().split(/\s+/);
    if (m[2] !== undefined && segs.join('').length < 40) continue;
    out.push('1.' + segs.join(' '));
  }
  return out;
}

async function decodeCandidate(cand) {
  const segs = cand.split(' ');
  for (let k = segs.length; k > 0; k--) {
    try {
      return await decodeContrib(segs.slice(0, k).join(''));
    } catch (e) {
      if (!(e instanceof CodecError)) throw e;
    }
  }
  return null;
}

/** Merges token candidates (from extractContribs) into the board. */
export async function mergeContribs(board, candidates) {
  const r = { added: 0, dupes: 0, foreign: 0, broken: 0 };
  for (const cand of candidates) {
    const c = await decodeCandidate(cand);
    if (!c) { r.broken++; continue; }
    r[addContrib(board, c)]++;
  }
  return r;
}

/**
 * Merges whatever a person pasted or dropped: a backup file (the board tuple
 * as JSON) or free text with contribution links. Chat exports also start
 * with "[" (a timestamp), so only text that really parses as JSON counts as
 * a backup; everything else is searched for tokens.
 */
export async function mergeText(board, text) {
  const trimmed = text.trim();
  if (/^[[{]/.test(trimmed) && /[\]}]$/.test(trimmed)) {
    let parsed;
    try { parsed = JSON.parse(trimmed); } catch { parsed = undefined; }
    if (parsed !== undefined) {
      try {
        return { broken: 0, ...mergeBoard(board, validate('board', parsed)) };
      } catch {
        return { added: 0, dupes: 0, foreign: 0, broken: 1 };
      }
    }
  }
  return mergeContribs(board, extractContribs(text));
}
