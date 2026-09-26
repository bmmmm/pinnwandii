// SPDX-License-Identifier: GPL-3.0-or-later
// Videos and GIFs in greetings. A pasted YouTube, Tenor or Giphy link is
// stored as one canonical https URL in the image slot, so tokens and storage
// keep their format and an older copy of the app still reads them (it shows
// at worst a broken image). parseMediaLink() normalizes a link once, when it
// is typed; mediaOf() reads any stored URL, raw links typed before included,
// and builds player and thumbnail addresses from the parsed id only. Pure
// ESM; playInline() is self-contained so the videos file (a finished page
// with players) can inline its source.
//
//   YouTube  https://www.youtube.com/watch?v=<id>[&t=<seconds>]   thumbnail, player on click
//   Tenor    https://tenor.com/view/<id>                          player on click (it loads trackers)
//   Giphy    https://i.giphy.com/media/<id>/giphy.webp            plain image
import { encodeBoard, toBase64 } from './codec.js';

const YOUTUBE = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be', 'youtube-nocookie.com', 'www.youtube-nocookie.com']);
const TENOR = new Set(['tenor.com', 'www.tenor.com']);
const GIPHY = /^(?:(?:www|i|media\d?)\.)?giphy\.com$/;
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const TENOR_ID = /^\d{1,24}$/;
const GIPHY_ID = /^[A-Za-z0-9]{6,40}$/;

/** Hosts of the players, for the frame-src of a Content-Security-Policy. */
export const FRAME_SRC = 'https://www.youtube-nocookie.com https://tenor.com';

// "90", "90s", "1m30s", "1h2m" -> seconds; 0 for anything else.
function seconds(v) {
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/.exec(v ?? '');
  if (!m || !v) return 0;
  const s = (Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60 + Number(m[3] ?? 0);
  return s < 1e6 ? s : 0;
}

// What a URL points to: { kind: 'youtube', id, start } | { kind: 'tenor', id }
// | { kind: 'giphy', id }; null for a page of these sites that is no single
// video or GIF (a channel, a short link); undefined for any other address.
function identify(u) {
  const host = u.hostname;
  const path = u.pathname;
  if (YOUTUBE.has(host)) {
    const id = host === 'youtu.be' ? /^\/([^/]+)\/?$/.exec(path)?.[1]
      : path === '/watch' ? u.searchParams.get('v')
      : /^\/(?:shorts|live|embed|v)\/([^/]+)\/?$/.exec(path)?.[1];
    // two playlist and stream pages have 11-character names
    if (!YOUTUBE_ID.test(id ?? '') || id === 'videoseries' || id === 'live_stream') return null;
    return { kind: 'youtube', id, start: seconds(u.searchParams.get('t') ?? u.searchParams.get('start')) };
  }
  if (TENOR.has(host)) {
    const id = /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(?:view\/(?:[^/]*-)?|embed\/)([^/-]+)\/?$/i.exec(path)?.[1];
    return TENOR_ID.test(id ?? '') ? { kind: 'tenor', id } : null;
  }
  if (host === 'gph.is') return null; // short links name no GIF id
  if (GIPHY.test(host)) {
    const id = (/^\/(?:gifs|stickers)\/(?:[^/]*-)?([^/-]+)\/?$/.exec(path)
      ?? /^\/embed\/([^/]+)\/?$/.exec(path)
      ?? /^\/media\/(?:v1\.[^/]+\/)?([^/]+)\/[^/]+$/.exec(path)
      ?? /^\/([^/.]+)\.(?:gif|webp)$/.exec(path))?.[1];
    return GIPHY_ID.test(id ?? '') ? { kind: 'giphy', id } : null;
  }
  return undefined;
}

function canonical(m) {
  if (m.kind === 'youtube') return `https://www.youtube.com/watch?v=${m.id}${m.start ? `&t=${m.start}` : ''}`;
  if (m.kind === 'tenor') return `https://tenor.com/view/${m.id}`;
  return `https://i.giphy.com/media/${m.id}/giphy.webp`;
}

/**
 * A pasted link as it is stored: YouTube, Tenor and Giphy links in their
 * canonical form (tracking parameters dropped, https added), any other input
 * trimmed but unchanged (the codec decides), and null for a page of these
 * sites that is no single video or GIF.
 */
export function parseMediaLink(input) {
  const raw = String(input ?? '').replace(/[\u200B-\u200D\u2060\uFEFF]/g, '').trim(); // share sheets add invisible characters
  let u;
  try {
    u = new URL(/^[a-z][a-z\d+.-]*:(?!\d)/i.test(raw) ? raw : `https://${raw}`); // host:port is no scheme
  } catch {
    return raw;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return raw;
  const m = identify(u);
  if (m === undefined) return raw;
  return m && canonical(m);
}

/**
 * What a card shows for a stored image: { kind: 'youtube', id, start, href,
 * thumb, embed } | { kind: 'tenor', id, href, embed } | { kind: 'image', src }
 * for any other https URL; null for photos and sketches (codec.imgSrc).
 */
export function mediaOf(img) {
  if (typeof img !== 'string' || !img.startsWith('https://')) return null;
  let m;
  try {
    m = identify(new URL(img));
  } catch {
    return { kind: 'image', src: img };
  }
  if (m?.kind === 'youtube') {
    return {
      ...m,
      href: canonical(m),
      thumb: `https://i.ytimg.com/vi/${m.id}/hqdefault.jpg`,
      embed: `https://www.youtube-nocookie.com/embed/${m.id}?autoplay=1${m.start ? `&start=${m.start}` : ''}`,
    };
  }
  if (m?.kind === 'tenor') return { ...m, href: canonical(m), embed: `https://tenor.com/embed/${m.id}` };
  return { kind: 'image', src: m ? canonical(m) : img };
}

/**
 * Plays videos and GIFs in place: a click on a card's media link inserts the
 * player after the link. Only on http(s): from a local file YouTube refuses
 * to play (no Referer), and the link opens the video on its site instead.
 * There the videos file keeps its "Online ansehen" bar; online it hides it.
 */
export function playInline(doc) {
  if (!/^https?:$/.test(doc.location.protocol)) return;
  for (const bar of doc.querySelectorAll('.online')) bar.hidden = true;
  doc.addEventListener('click', (e) => {
    const a = e.target.closest?.('a.media[data-embed]:not(.played)');
    if (!a || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    const f = doc.createElement('iframe');
    f.className = a.className;
    f.src = a.dataset.embed;
    f.title = a.dataset.title;
    f.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
    f.allowFullscreen = true;
    f.referrerPolicy = 'strict-origin-when-cross-origin';
    a.after(f);
    a.classList.add('played');
    f.focus();
  });
}

// ---- the videos file ------------------------------------------------------------

/** The script of the videos file. */
export const PLAYER_JS = `(${playInline})(document);`.replace(/\r\n?/g, '\n');

/** CSP source for an inline script: 'sha256-…' of its text. */
export async function scriptHash(js) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(js));
  return `'sha256-${toBase64(new Uint8Array(digest))}'`;
}

const playable = (c) => ['youtube', 'tenor'].includes(mediaOf(c.img)?.kind);
/** True if a board has a card that needs a player (a YouTube video, a Tenor GIF). */
export const hasPlayable = (board) => board.contribs.some(playable);

/**
 * The online view (#v=) of a videos file in at most `cap` characters, as
 * { token, scope }: the whole board ('all') if it fits, else every card
 * without its photo ('text'), else only the cards that need a player
 * ('videos'), else null; null too for a board without such cards. A view
 * needs no origins and no deleted list.
 */
export async function viewToken(board, cap) {
  if (!hasPlayable(board)) return null;
  const photo = (img) => img.startsWith('data:') || img.startsWith('sketch:');
  const rungs = [
    ['all', board.contribs],
    ['text', board.contribs.map((c) => (photo(c.img) ? { ...c, img: '' } : c))],
    ['videos', board.contribs.filter(playable)],
  ];
  for (const [scope, contribs] of rungs) {
    const token = await encodeBoard({ ...board, contribs: contribs.map(({ origin, ...c }) => c), deleted: [] });
    if (token.length <= cap) return { token, scope };
  }
  return null;
}
