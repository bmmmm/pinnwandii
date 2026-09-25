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
//   board   = [id, title, preset, hue, [[name, text, sticker, img, origin], …], [deleted origin, …]]
//             (before version 3 without origins and deleted list)
//   img     = "" | "https://…" | <number n: the next |n| bytes of the tail>
//             n > 0: a JPEG photo, stored without its header (jpeg.js) when
//             this app encoded it; n < 0: a sketch from version 2 (sketch.js)
// In memory and in storage a photo is a full JPEG data URI and a sketch
// "sketch:<base64>"; imgSrc() turns either into an <img> source.
// toTuple()/validate() convert between tuples and plain objects.
// Versions: 1 JPEG photos, 2 sketches, 3 JPEGs without header, origins. New
// tokens are written as 3; older ones are still read.
//
// Origin: every post on a board remembers a short hash of the contribution
// it came from, and a board remembers the origins of deleted posts. Merging
// the same links or an older backup again therefore neither duplicates an
// edited post nor brings back a deleted one.
import { stripJpeg, unstripJpeg } from './jpeg.js';
import { MAX_BYTES as SKETCH_BYTES, isSketch, sketchSvg } from './sketch.js';

export const VERSION = '3';
const READABLE = ['1', '2', '3'];
export const PRESETS = ['p', 'b', 'd'];
export const LIMITS = Object.freeze({
  title: 80, name: 60, text: 1000, sticker: 8, url: 500,
  photo: 28 * 1024, sketch: SKETCH_BYTES, contribs: 500, deleted: 2000, token: 200_000,
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
  if (!READABLE.includes(ver)) {
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
const ORIGIN_RE = /^[A-Za-z0-9_-]{8}$/;
const URL_RE = /^https:\/\/\S+$/;
const DATA_RE = /^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/;
const SKETCH = 'sketch:';
const SKETCH_RE = /^sketch:([A-Za-z0-9+/]+={0,2})$/;
const isStr = (v, max, min = 1) => typeof v === 'string' && v.length >= min && v.length <= max;
const dataUriBytes = (b64) =>
  Math.floor((b64.length * 3) / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);

// `wire`: a tuple straight from a token, whose photos are still byte counts
// into the tail. Everywhere else (storage, backups) a number is invalid: it
// would pass here and break encoding and rendering later.
function checkImg(img, wire) {
  if (img === '') return;
  if (typeof img === 'number') {
    if (!wire) fail('invalid', 'Bild: falscher Typ.');
    if (Number.isInteger(img) && img > 0 && img <= LIMITS.photo) return;
    if (Number.isInteger(img) && img < 0 && -img <= LIMITS.sketch) return;
    fail('invalid', 'Foto zu groß.');
  }
  if (typeof img !== 'string') fail('invalid', 'Bild: falscher Typ.');
  if (URL_RE.test(img) && img.length <= LIMITS.url) return;
  const m = DATA_RE.exec(img);
  if (m && dataUriBytes(m[1]) <= LIMITS.photo) return;
  if (sketchBytes(img)) return;
  fail('invalid', `Bild, Video oder GIF: ein https-Link mit höchstens ${LIMITS.url} Zeichen oder ein kleines Foto.`);
}
function checkEntry(t, wire = false) {
  if (!Array.isArray(t) || t.length !== 4) fail('invalid', 'Beitrag: falscher Typ.');
  const [name, text, sticker, img] = t;
  if (!isStr(name, LIMITS.name)) fail('invalid', `Name: 1 bis ${LIMITS.name} Zeichen.`);
  if (!isStr(text, LIMITS.text)) fail('invalid', `Text: 1 bis ${LIMITS.text} Zeichen.`);
  if (typeof sticker !== 'string' || [...sticker].length > LIMITS.sticker) fail('invalid', 'Sticker: zu lang.');
  checkImg(img, wire);
  return { name, text, sticker, img };
}
// A board entry: a contribution plus its origin (missing before version 3,
// then the post is taken as unedited and the origin computed from it).
function checkPost(t, wire) {
  if (!Array.isArray(t) || (t.length !== 4 && t.length !== 5)) fail('invalid', 'Beitrag: falscher Typ.');
  const e = checkEntry(t.slice(0, 4), wire);
  if (t.length === 5 && (typeof t[4] !== 'string' || !ORIGIN_RE.test(t[4]))) fail('invalid', 'Herkunft ungültig.');
  e.origin = t[4] ?? (wire ? null : originOf(e));
  return e;
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
export function validate(kind, t, { wire = false } = {}) {
  if (kind === 'invite') return checkHead(t, 4);
  if (kind === 'board') {
    const b = checkHead(Array.isArray(t) ? t.slice(0, 5) : t, 5);
    if (t.length > 6) fail('invalid', 'Falscher Typ.');
    if (!Array.isArray(t[4])) fail('invalid', 'Beiträge: falscher Typ.');
    if (t[4].length > LIMITS.contribs) fail('invalid', `Höchstens ${LIMITS.contribs} Beiträge.`);
    b.contribs = t[4].map((e) => checkPost(e, wire));
    const deleted = t[5] ?? [];
    if (!Array.isArray(deleted) || deleted.length > LIMITS.deleted || !deleted.every((o) => typeof o === 'string' && ORIGIN_RE.test(o))) {
      fail('invalid', 'Gelöschte: falscher Typ.');
    }
    b.deleted = deleted;
    return b;
  }
  if (kind === 'contrib') {
    if (!Array.isArray(t) || t.length !== 5) fail('invalid', 'Beitrag: falscher Typ.');
    if (typeof t[0] !== 'string' || !ID_RE.test(t[0])) fail('invalid', 'Kennung ungültig.');
    return { id: t[0], ...checkEntry(t.slice(1), wire) };
  }
  throw new Error(`unknown kind: ${kind}`);
}

export function toTuple(kind, o) {
  if (kind === 'invite') return [o.id, o.title, o.preset, o.hue];
  if (kind === 'contrib') return [o.id, o.name, o.text, o.sticker, o.img];
  if (kind === 'board') {
    // Unedited posts and an empty deleted list are written as before version
    // 3 (origins follow from the content), so an uncurated board stays
    // readable by an older copy of the app, e.g. a tab opened before an update.
    const entries = o.contribs.map((c) => {
      const t = [c.name, c.text, c.sticker, c.img];
      return c.origin && c.origin !== originOf(c) ? [...t, c.origin] : t;
    });
    return o.deleted?.length ? [o.id, o.title, o.preset, o.hue, entries, o.deleted] : [o.id, o.title, o.preset, o.hue, entries];
  }
  throw new Error(`unknown kind: ${kind}`);
}

export function newId() {
  return toBase64url(crypto.getRandomValues(new Uint8Array(6))).slice(0, 6);
}

/** Origin of a contribution: 48-bit hash (cyrb53) of its content, 8 characters. */
export function originOf(c) {
  const str = JSON.stringify([c.name, c.text, c.sticker, c.img]);
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const bytes = new Uint8Array(6);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, h1 >>> 0);
  view.setUint16(4, h2 & 0xffff);
  return toBase64url(bytes);
}

// ---- photos: sketches and data URIs <-> binary tail --------------------------

/** The bytes of a "sketch:" image, or null if `img` is no valid sketch. */
export function sketchBytes(img) {
  const m = SKETCH_RE.exec(img);
  if (!m) return null;
  let bytes;
  try { bytes = fromBase64(m[1]); } catch { return null; }
  return isSketch(bytes) ? bytes : null;
}
export const sketchImg = (bytes) => SKETCH + toBase64(bytes);

/** Source for an <img>: sketches become SVG data URIs, other images already are URLs. */
export function imgSrc(img) {
  const bytes = sketchBytes(img);
  return bytes ? 'data:image/svg+xml;base64,' + btoa(sketchSvg(bytes)) : img;
}

function splitPhotos(entries) {
  const bins = [];
  const wired = entries.map(([name, text, sticker, img, ...rest]) => {
    const sketch = img.startsWith(SKETCH);
    if (!sketch && !img.startsWith('data:')) return [name, text, sticker, img, ...rest];
    let bytes = fromBase64(img.slice(sketch ? SKETCH.length : img.indexOf(',') + 1));
    if (!sketch) bytes = stripJpeg(bytes) ?? bytes;
    bins.push(bytes);
    return [name, text, sticker, sketch ? -bytes.length : bytes.length, ...rest];
  });
  return [wired, bins];
}
function joinPhotos(entries, tail) {
  let off = 0;
  const out = entries.map(([name, text, sticker, img, ...rest]) => {
    if (typeof img !== 'number') return [name, text, sticker, img, ...rest];
    const n = Math.abs(img);
    let bytes = tail.subarray(off, off + n);
    off += n;
    if (img < 0) return [name, text, sticker, SKETCH + toBase64(bytes), ...rest];
    if (bytes[0] === 1) bytes = unstripJpeg(bytes) ?? fail('broken', MESSAGES.broken); // a JPEG starts with 0xFF
    return [name, text, sticker, 'data:image/jpeg;base64,' + toBase64(bytes), ...rest];
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
  validate('contrib', obj, { wire: true });
  const [entry] = joinPhotos([obj.slice(1)], tail);
  return validate('contrib', [obj[0], ...entry]);
}

export async function encodeBoard(b) {
  const t = toTuple('board', b);
  validate('board', t);
  const [wired, bins] = splitPhotos(t[4]);
  return pack([...t.slice(0, 4), wired, ...t.slice(5)], bins);
}
export async function decodeBoard(str) {
  const { obj, tail } = await unpack(str);
  validate('board', obj, { wire: true });
  return validate('board', [...obj.slice(0, 4), joinPhotos(obj[4], tail), ...obj.slice(5)]);
}

// ---- merging ----------------------------------------------------------------

// Adds a post with a known origin: 'added' | 'dupes' (the board has or had
// it, possibly edited or deleted since) | 'full'.
function addPost(board, e) {
  if (board.contribs.some((x) => x.origin === e.origin) || (board.deleted ??= []).includes(e.origin)) return 'dupes';
  if (board.contribs.length >= LIMITS.contribs) return 'full';
  board.contribs.push({ name: e.name, text: e.text, sticker: e.sticker, img: e.img, origin: e.origin });
  return 'added';
}

/** Adds one contribution to a board; returns 'added' | 'dupes' | 'foreign' | 'full'. */
export function addContrib(board, c) {
  if (c.id !== board.id) return 'foreign';
  return addPost(board, { ...c, origin: originOf(c) });
}

/** Records a post as deleted, so that merging it again does not bring it back. */
export function deletePost(board, origin) {
  board.contribs = board.contribs.filter((e) => e.origin !== origin);
  board.deleted ??= [];
  if (!board.deleted.includes(origin)) board.deleted = [...board.deleted, origin].slice(-LIMITS.deleted);
}

/** Posts of `board` that `other` (a copy of the same board) has deleted. */
export const deletedIn = (board, other) =>
  other.id === board.id ? board.contribs.filter((e) => (other.deleted ?? []).includes(e.origin)) : [];

/**
 * Merges another copy of the same board (admin link, backup) into `board`:
 * posts deleted there are deleted here too (unless `deletions` is false),
 * posts known here stay as they are here (edits on this device win), new
 * posts are added.
 */
export function mergeBoard(board, other, { deletions = true } = {}) {
  const r = { added: 0, dupes: 0, foreign: 0, full: 0, removed: 0 };
  if (other.id !== board.id) {
    r.foreign = other.contribs.length;
    return r;
  }
  for (const origin of deletions ? other.deleted ?? [] : []) {
    const before = board.contribs.length;
    deletePost(board, origin);
    r.removed += before - board.contribs.length;
  }
  for (const e of other.contribs) r[addPost(board, { ...e, origin: e.origin ?? originOf(e) })]++;
  return r;
}

// A token is "<version>.<base64url>", found after "#c=" or on its own. Token
// runs may contain whitespace: mail clients wrap long lines. The run is kept
// as whitespace-separated segments so the merge can drop trailing segments
// that turn out to be ordinary text following the link; a segment starting
// like a new token ("2.…") ends the run. A token on its own must start with
// "AA" (a contribution's u32 length prefix is below 2^16) and be long, so
// "1. November" or "Version 1.2" are no candidates, and "#i="/"#b=" links
// are skipped. No lookbehind: Safari < 16.4 cannot parse it, and one regex
// it cannot parse leaves the whole page blank.
const TOKEN_RE = /(#c=|^|[^A-Za-z0-9_\-.=#])(\d)\.([A-Za-z0-9_-]+(?:\s+(?!\d\.)[A-Za-z0-9_-]+)*)/g;

/** Finds contribution token candidates in free text (chat exports, mails). */
export function extractContribs(text) {
  const out = [];
  for (const [, before, ver, run] of text.matchAll(TOKEN_RE)) {
    const segs = run.split(/\s+/);
    if (before !== '#c=' && (!run.startsWith('AA') || segs.join('').length < 40)) continue;
    out.push(ver + '.' + segs.join(' '));
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
  const r = { added: 0, dupes: 0, foreign: 0, broken: 0, full: 0 };
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
 * a backup; everything else is searched for tokens. So is JSON that is no
 * backup (Telegram exports chats as JSON); without any token it is counted
 * as one broken item.
 */
export async function mergeText(board, text, opts) {
  const other = parseBackup(text);
  if (other) return { broken: 0, ...mergeBoard(board, other, opts) };
  const cands = extractContribs(text);
  if (looksLikeJson(text) && cands.length === 0) return { added: 0, dupes: 0, foreign: 0, broken: 1, full: 0 };
  return mergeContribs(board, cands);
}
const looksLikeJson = (text) => {
  const t = text.trim();
  if (!/^[[{]/.test(t) || !/[\]}]$/.test(t)) return false;
  try { JSON.parse(t); return true; } catch { return false; }
};
/** The board in a backup (the board tuple as JSON), or null. */
export function parseBackup(text) {
  if (!looksLikeJson(text)) return null;
  try { return validate('board', JSON.parse(text.trim())); } catch { return null; }
}
