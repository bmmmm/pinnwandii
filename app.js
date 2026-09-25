// SPDX-License-Identifier: GPL-3.0-or-later
// pinnwandii app: hash router, views, localStorage store, photo pipeline,
// sharing, merge dialog and the static page builder. All user content is
// rendered through textContent / createElement, never through innerHTML.
import * as codec from './codec.js';
import { MAX_SIDE, encodeJpeg, ssim, strippedLength } from './jpeg.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const field = (form, name) => form.elements.namedItem(name);
const STICKERS = ['🎉', '🎂', '🎈', '🥳', '❤️', '🌟', '🍀', '🌸', '🎁', '🥂', '🎶', '☀️', '🐣', '🏆', '🙌', '💐'];
const BASE = location.href.split(/[?#]/)[0]; // without ?fbclid= and the like
const DEFAULT_THEME = { title: 'Pinnwand', preset: 'p', hue: 210 };
const KB = (n) => `${(n / 1024).toFixed(1).replace('.', ',')} KB`;
const plural = (n) => (n === 1 ? '1 Beitrag' : `${n} Beiträge`);
const SAVE_FAILED = 'Speichern nicht möglich: Speicher voll oder gesperrt. Lade eine Sicherung herunter.';
const fullNote = (n) => (n ? ` ${n} nicht übernommen: Pinnwand voll (höchstens ${codec.LIMITS.contribs}).` : '');
const entryKey = (e) => JSON.stringify([e.name, e.text, e.sticker, e.img]);
// Signal (Android, Desktop) sends text over 2048 UTF-8 bytes as an attachment,
// and the link arrives cut off; Telegram splits at 4096 characters. The whole
// message stays below that, with room for a few words added by hand.
const MESSAGE_BUDGET = 1900;
const utf8Length = (s) => new TextEncoder().encode(s).length;

function h(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  Object.assign(e, props);
  e.append(...kids.filter((k) => k !== '' && k != null));
  return e;
}

// ---- toast and dialogs ------------------------------------------------------

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  try { t.showPopover(); } catch { t.hidden = false; }
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    try { t.hidePopover(); } catch { t.hidden = true; }
  }, 3500);
}

function confirmDialog(text) {
  return new Promise((resolve) => {
    const d = $('#dlg-confirm');
    $('#confirm-text').textContent = text;
    d.addEventListener('close', () => resolve(d.returnValue === 'ok'), { once: true });
    d.returnValue = '';
    d.showModal();
  });
}
$('#confirm-ok').onclick = () => $('#dlg-confirm').close('ok');
$('#confirm-cancel').onclick = () => $('#dlg-confirm').close('cancel');
$$('dialog [data-close]').forEach((b) => { b.onclick = () => b.closest('dialog').close(); });

// ---- store (localStorage, tuples with data URIs) ----------------------------

const store = {
  key: (id) => `pinnwandii:${id}`,
  load(id) {
    try {
      const raw = localStorage.getItem(this.key(id));
      return raw ? codec.validate('board', JSON.parse(raw)) : null;
    } catch {
      return null;
    }
  },
  save(board) {
    try {
      localStorage.setItem(this.key(board.id), JSON.stringify(codec.toTuple('board', board)));
      localStorage.setItem('pinnwandii:last', board.id);
      return true;
    } catch {
      toast(SAVE_FAILED);
      return false;
    }
  },
  remove(id) {
    try { localStorage.removeItem(this.key(id)); } catch { /* nothing to do */ }
  },
  list() {
    const out = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k.startsWith('pinnwandii:') || k === 'pinnwandii:last') continue;
        const b = this.load(k.slice('pinnwandii:'.length));
        if (b) out.push(b);
      }
    } catch { /* storage blocked: nothing saved */ }
    return out;
  },
};

// ---- sharing, copying, downloads --------------------------------------------

async function shareText(text) {
  try {
    await navigator.share({ text });
    return true;
  } catch (e) {
    if (e.name !== 'AbortError') toast('Teilen nicht möglich, bitte kopieren.');
    return false;
  }
}
async function shareFiles(files) {
  try {
    await navigator.share({ files });
    return true;
  } catch (e) {
    if (e.name !== 'AbortError') toast('Teilen nicht möglich, bitte herunterladen.');
    return false;
  }
}
const canShareFiles = (files) => !!navigator.canShare && navigator.canShare({ files });
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Kopiert.');
    return true;
  } catch {
    toast('Kopieren nicht möglich: bitte den Text markieren und kopieren.');
    return false;
  }
}
function download(blob, name) {
  const a = h('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
}
const slug = (s) => s.normalize('NFKD').replace(/\p{M}+/gu, '').replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'gruss';

// ---- theme and cards --------------------------------------------------------

function applyTheme({ title, preset, hue }) {
  document.body.dataset.preset = preset;
  document.body.style.setProperty('--hue', hue);
  $('#title').textContent = title;
  document.title = title;
}
function bindThemeInputs(form, onInput) {
  form.addEventListener('input', () => {
    applyTheme({
      title: field(form, 'title').value.trim() || DEFAULT_THEME.title,
      preset: field(form, 'preset').value,
      hue: Number(field(form, 'hue').value),
    });
    onInput?.();
  });
}

const rotOf = (i) => (((i * 7) % 5) - 2) * 0.7;

// Same function for the live wall, the preview and the built static page.
function renderCard(c, i, doc = document) {
  const card = doc.createElement('article');
  card.className = 'card';
  card.style.setProperty('--i', i);
  card.style.setProperty('--r', rotOf(i));
  if (c.img) {
    const img = doc.createElement('img');
    img.src = codec.imgSrc(c.img);
    img.alt = '';
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    card.append(img);
  }
  if (c.sticker) {
    const s = doc.createElement('span');
    s.className = 'sticker';
    s.textContent = c.sticker;
    card.append(s);
  }
  const text = doc.createElement('p');
  text.className = 'text';
  text.dir = 'auto';
  text.textContent = c.text;
  const name = doc.createElement('p');
  name.className = 'name';
  name.dir = 'auto';
  name.textContent = c.name;
  card.append(text, name);
  return card;
}
function renderWall(board, doc = document) {
  const wall = doc.createElement('div');
  wall.className = 'wall';
  board.contribs.forEach((c, i) => wall.append(renderCard(c, i, doc)));
  return wall;
}

// ---- router -----------------------------------------------------------------

let current = null; // board shown in the organizer view
let highlightFrom = Infinity; // index of the first card to highlight on next render

// Other tabs (a #c= link opened from a messenger) save the same board, so
// storage is the source of truth: reload before every change and follow
// saves made elsewhere. Unsaved slider/title edits in an open settings
// dialog are kept on top of the fresh copy.
function reloadCurrent() {
  if (!current) return null;
  const fresh = store.load(current.id);
  if (!fresh) return current;
  if ($('#dlg-settings').open) Object.assign(fresh, { title: current.title, preset: current.preset, hue: current.hue });
  current = fresh;
  return current;
}
window.addEventListener('storage', (e) => {
  if (!current || e.key !== store.key(current.id)) return;
  reloadCurrent();
  applyTheme(current);
  renderBoard(current);
  if ($('#dlg-merge').open) renderMergeList();
});

function show(id) {
  $$('main > section').forEach((s) => { s.hidden = s.id !== id; });
  $$('dialog[open]').forEach((d) => d.close());
  window.scrollTo(0, 0);
}

// Safari before 16.4 and other old browsers cannot pack or read any link.
const TOO_OLD = typeof CompressionStream === 'undefined' || typeof DecompressionStream === 'undefined';

async function route() {
  const m = /^#([oicbv])=(.*)$/.exec(location.hash);
  try {
    if (TOO_OLD) return showError(new Error('Dieser Browser ist zu alt für die Pinnwand. Bitte aktualisiere ihn oder öffne den Link in einem anderen Browser.'));
    if (!m) return showStart();
    const [, mode, val] = m;
    if (mode === 'o') return showBoard(val);
    if (mode === 'v') return showView(await codec.decodeBoard(val));
    if (mode === 'i') return showWrite(await codec.decodeInvite(val));
    if (mode === 'c') return receive(await codec.decodeContrib(val));
    if (mode === 'b') return adopt(await codec.decodeBoard(val));
  } catch (e) {
    showError(e);
  }
}

function showError(e) {
  applyTheme(DEFAULT_THEME);
  $('#error-text').textContent = e?.message || 'Unbekannter Fehler.';
  show('view-error');
}
$('#error-new').onclick = () => { location.hash = ''; };

// ---- start ------------------------------------------------------------------

function showStart() {
  current = null;
  applyTheme(DEFAULT_THEME);
  const boards = store.list();
  $('#saved-panel').hidden = boards.length === 0;
  $('#saved').replaceChildren(...boards.map((b) => h('li', {},
    h('a', { href: `#o=${b.id}`, textContent: b.title }),
    h('span', { className: 'snippet', textContent: plural(b.contribs.length) }),
  )));
  show('view-start');
}
bindThemeInputs($('#new-form'));
$('#new-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target;
  const board = {
    id: codec.newId(),
    title: field(f, 'title').value.trim(),
    preset: field(f, 'preset').value,
    hue: Number(field(f, 'hue').value),
    contribs: [],
  };
  try {
    codec.validate('board', codec.toTuple('board', board));
  } catch (err) {
    return toast(err.message);
  }
  if (!store.save(board)) return;
  f.reset();
  location.hash = `#o=${board.id}`;
});
$('#restore').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const b = codec.validate('board', JSON.parse(await file.text()));
    const local = store.load(b.id);
    if (local) {
      const r = codec.mergeBoard(local, b);
      if (!store.save(local)) return;
      toast(`Sicherung zusammengeführt: ${r.added} neue Beiträge.${fullNote(r.full)}`);
    } else {
      if (!store.save(b)) return;
      toast(`Pinnwand „${b.title}“ geladen (${plural(b.contribs.length)}).`);
    }
    location.hash = `#o=${b.id}`;
  } catch {
    toast('Das ist keine Sicherung dieser App.');
  }
});

// ---- organizer and viewer ---------------------------------------------------

function showBoard(id) {
  const board = store.load(id);
  if (!board) {
    return showError(new Error('Diese Pinnwand liegt nicht auf diesem Gerät. Öffne zuerst deinen Admin-Link oder lade auf der Startseite deine Sicherung.'));
  }
  current = board;
  applyTheme(board);
  $('#toolbar').hidden = false;
  renderBoard(board, highlightFrom);
  highlightFrom = Infinity;
  show('view-board');
}
function showView(board) {
  current = null;
  applyTheme(board);
  $('#toolbar').hidden = true;
  renderBoard(board);
  show('view-board');
}
async function renderBoard(board, newFrom = Infinity) {
  const wall = renderWall(board);
  const cards = [...wall.children];
  cards.slice(newFrom).forEach((c) => c.classList.add('new'));
  $('#wall').replaceChildren(...cards);
  $('#empty').hidden = board.contribs.length > 0 || board !== current;
  const meta = $('#meta');
  meta.textContent = plural(board.contribs.length);
  if (newFrom < Infinity) setTimeout(() => cards.forEach((c) => c.classList.remove('new')), 2000);
  if (board !== current) return;
  const link = await adminLink(board);
  if (board === current) meta.textContent = `${plural(board.contribs.length)} · Admin-Link: ${KB(link.length)}`;
}
const adminLink = async (board) => `${BASE}#b=${await codec.encodeBoard(board)}`;

function showReceive(c, hint) {
  applyTheme(DEFAULT_THEME);
  $('#receive-card').replaceChildren(renderCard(c, 0));
  $('#receive-hint').textContent = hint;
  show('view-receive');
}
function receive(c) {
  const board = store.load(c.id);
  if (!board) {
    return showReceive(c, 'Diese Pinnwand liegt nicht auf diesem Gerät. Öffne zuerst deinen Admin-Link oder lade auf der Startseite deine Sicherung, dann tippe diesen Link noch einmal an.');
  }
  const before = board.contribs.length;
  const r = codec.addContrib(board, c);
  if (r === 'full') return showReceive(c, `Die Pinnwand ist voll (höchstens ${codec.LIMITS.contribs} Beiträge). Dieser Beitrag wurde nicht übernommen.`);
  if (!store.save(board)) return showReceive(c, `${SAVE_FAILED} Der Beitrag wurde nicht übernommen.`);
  if (r === 'added') {
    highlightFrom = before;
    toast(`Beitrag von ${c.name} übernommen (${board.contribs.length}).`);
  } else {
    toast(`Beitrag von ${c.name} war schon da.`);
  }
  location.replace(`#o=${board.id}`);
}

function adopt(b) {
  const local = store.load(b.id);
  if (local) {
    const before = local.contribs.length;
    const r = codec.mergeBoard(local, b);
    if (!store.save(local)) return showError(new Error(SAVE_FAILED));
    highlightFrom = before;
    toast(`Pinnwand zusammengeführt: ${r.added} neue Beiträge.${fullNote(r.full)}`);
  } else {
    if (!store.save(b)) return showError(new Error(SAVE_FAILED));
    toast(`Pinnwand „${b.title}“ übernommen (${plural(b.contribs.length)}).`);
  }
  location.replace(`#o=${b.id}`);
}

$('#toolbar').addEventListener('click', (e) => {
  const act = e.target.closest('button')?.dataset.act;
  if (act === 'invite') openInvite();
  if (act === 'merge') openMerge();
  if (act === 'build') openBuild();
  if (act === 'settings') openSettings();
});

// ---- share dialog -----------------------------------------------------------

function openShare(title, hint, text) {
  $('#share-title').textContent = title;
  $('#share-hint').textContent = hint;
  $('#share-text').value = text;
  $('#share-share').hidden = !navigator.share;
  $('#dlg-share').showModal();
}
$('#share-share').onclick = () => shareText($('#share-text').value);
$('#share-copy').onclick = () => copyText($('#share-text').value);

async function openInvite() {
  const link = `${BASE}#i=${await codec.encodeInvite(current)}`;
  openShare(
    'Einladen',
    'Schick diesen Link an alle, die etwas schreiben sollen. Die Antworten kommen als Links zurück, die du über „Einsammeln“ aufnimmst.',
    `Schreib einen Glückwunsch auf die Pinnwand „${current.title}“: ${link}`,
  );
}

// ---- merge dialog -----------------------------------------------------------

function openMerge() {
  $('#merge-text').value = '';
  $('#merge-result').textContent = '';
  renderMergeList();
  $('#dlg-merge').showModal();
}
function renderMergeList() {
  const count = new Map();
  current.contribs.forEach((c) => count.set(c.name, (count.get(c.name) ?? 0) + 1));
  $('#merge-list').replaceChildren(...current.contribs.map((c, i) => h('li', {},
    h('span', { className: 'who', textContent: c.name }),
    count.get(c.name) > 1 ? h('span', { className: 'dup', textContent: 'Name doppelt' }) : '',
    h('span', { className: 'snippet', textContent: c.text }),
    h('button', { type: 'button', className: 'x', textContent: '✕', title: 'Beitrag löschen', onclick: () => removeContrib(i) }),
  )));
}
async function removeContrib(i) {
  const c = current.contribs[i];
  if (!c || !(await confirmDialog(`Beitrag von ${c.name} löschen?`))) return;
  reloadCurrent();
  const idx = current.contribs.findIndex((e) => entryKey(e) === entryKey(c));
  if (idx >= 0) current.contribs.splice(idx, 1);
  store.save(current);
  renderBoard(current);
  renderMergeList();
}

async function mergeRun(texts) {
  reloadCurrent();
  const before = current.contribs.length;
  const total = { added: 0, dupes: 0, foreign: 0, broken: 0, full: 0 };
  for (const t of texts) {
    const r = await codec.mergeText(current, t);
    for (const k of Object.keys(total)) total[k] += r[k];
  }
  const saved = store.save(current);
  renderBoard(current, before);
  renderMergeList();
  $('#merge-result').textContent = `${total.added} übernommen, ${total.dupes} doppelt, ${total.foreign} fremde Pinnwand, ${total.broken} defekt${saved ? '' : ' – nicht gespeichert!'}${total.full ? '.' + fullNote(total.full) : ''}`;
}
async function readFiles(files) {
  try {
    return await Promise.all([...files].map((f) => f.text()));
  } catch {
    toast('Eine Datei konnte nicht gelesen werden.');
    return [];
  }
}

$('#merge-go').onclick = async () => {
  await mergeRun([$('#merge-text').value]);
  $('#merge-text').value = '';
};
$('#merge-clip').onclick = async () => {
  try {
    await mergeRun([await navigator.clipboard.readText()]);
  } catch {
    toast('Kein Zugriff auf die Zwischenablage: bitte in das Feld einfügen.');
  }
};
$('#merge-files').addEventListener('change', async (e) => {
  await mergeRun(await readFiles(e.target.files));
  e.target.value = '';
});
$('#merge-text').addEventListener('dragover', (e) => e.preventDefault());
$('#merge-text').addEventListener('drop', async (e) => {
  e.preventDefault();
  if (e.dataTransfer.files.length) await mergeRun(await readFiles(e.dataTransfer.files));
});

// ---- static page ------------------------------------------------------------

let cssText = null;
const CSS_FAILED = 'Stylesheet nicht ladbar, bitte Seite neu laden.';
const loadCss = async () => (cssText ??= await fetch('style.css').then((r) => {
  if (!r.ok) throw new Error(`style.css: HTTP ${r.status}`);
  return r.text();
}));

function buildStaticPage(board, css) {
  const doc = document.implementation.createHTMLDocument(board.title);
  doc.documentElement.lang = 'de';
  const charset = doc.createElement('meta');
  charset.setAttribute('charset', 'utf-8');
  const viewport = doc.createElement('meta');
  viewport.name = 'viewport';
  viewport.content = 'width=device-width, initial-scale=1';
  const csp = doc.createElement('meta');
  csp.httpEquiv = 'Content-Security-Policy';
  csp.content = "default-src 'none'; style-src 'unsafe-inline'; img-src https: data:";
  const title = doc.createElement('title');
  title.textContent = board.title;
  const style = doc.createElement('style');
  style.textContent = css;
  doc.head.replaceChildren(charset, viewport, csp, title, style);
  doc.body.dataset.preset = board.preset;
  doc.body.style.setProperty('--hue', board.hue);
  const header = doc.createElement('header');
  header.className = 'top';
  const h1 = doc.createElement('h1');
  h1.textContent = board.title;
  header.append(h1);
  const main = doc.createElement('main');
  main.append(renderWall(board, doc));
  doc.body.append(header, main);
  return `<!doctype html>\n${doc.documentElement.outerHTML}`;
}
// The finished page as a file, or null (with a toast) if the stylesheet cannot be loaded.
async function pageFile(board) {
  let css;
  try {
    css = await loadCss();
  } catch {
    toast(CSS_FAILED);
    return null;
  }
  return new File([buildStaticPage(board, css)], `pinnwand-${board.id}.html`, { type: 'text/html' });
}

function openBuild() {
  loadCss().catch(() => toast(CSS_FAILED));
  $('#build-share').hidden = !navigator.canShare;
  $('#dlg-build').showModal();
}
$('#build-preview').onclick = async () => {
  const f = await pageFile(current);
  if (!f) return;
  const url = URL.createObjectURL(f);
  const win = window.open(url, '_blank');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  if (!win) toast('Der Browser hat das Fenster blockiert: bitte herunterladen.');
};
$('#build-download').onclick = async () => {
  const f = await pageFile(current);
  if (f) download(f, f.name);
};
$('#build-share').onclick = async () => {
  const f = await pageFile(current);
  if (!f) return;
  if (canShareFiles([f])) await shareFiles([f]);
  else toast('Dateien teilen geht hier nicht: bitte herunterladen.');
};

// ---- settings ---------------------------------------------------------------

const settingsForm = $('#settings-form');
let settingsFor = null; // id of the board the settings dialog was opened for
function openSettings() {
  settingsFor = current.id;
  field(settingsForm, 'title').value = current.title;
  field(settingsForm, 'preset').value = current.preset;
  field(settingsForm, 'hue').value = current.hue;
  $('#admin-note').textContent = '';
  $('#dlg-settings').showModal();
}
function applySettingsForm(b = current) {
  b.title = field(settingsForm, 'title').value.trim() || b.title;
  b.preset = field(settingsForm, 'preset').value;
  b.hue = Number(field(settingsForm, 'hue').value);
}
bindThemeInputs(settingsForm, () => { if (current) applySettingsForm(); });
// A text field commits on blur, which can come after a route change closed
// the dialog: the edit belongs to the board the dialog was opened for, not
// to the one shown by then.
settingsForm.addEventListener('change', () => {
  const b = current?.id === settingsFor ? reloadCurrent() : store.load(settingsFor);
  if (!b) return;
  applySettingsForm(b);
  store.save(b);
  if (b === current) renderBoard(current);
});
settingsForm.addEventListener('submit', (e) => e.preventDefault());
$('#admin-link').onclick = async () => {
  const link = await adminLink(current);
  if (link.length > 32_000) {
    $('#admin-note').textContent = `Der Admin-Link wäre ${KB(link.length)} groß, zu viel für einen Link. Nutze die Sicherung.`;
    return;
  }
  openShare('Admin-Link', 'Öffne diesen Link auf dem anderen Gerät: Dort erscheint die Pinnwand mit allen Beiträgen.', link);
};
$('#backup').onclick = () => {
  const json = JSON.stringify(codec.toTuple('board', current));
  download(new Blob([json], { type: 'application/json' }), `pinnwand-${current.id}.json`);
};
$('#delete-board').onclick = async () => {
  if (!(await confirmDialog(`Pinnwand „${current.title}“ von diesem Gerät löschen?`))) return;
  store.remove(current.id);
  location.hash = '';
};

// ---- write (invitation) -----------------------------------------------------

const writeForm = $('#write-form');
let write = null; // { invite, photo, link, timer, pending, shrinking, abort, error }

function showWrite(invite) {
  current = null;
  write?.abort?.abort(); // a photo of the previous invitation still being prepared
  write = { invite, photo: '', link: '', timer: 0, pending: null, shrinking: null, abort: null, error: '' };
  applyTheme(invite);
  writeForm.reset();
  $('#sticker-row').replaceChildren(...STICKERS.map((s) => {
    const b = h('button', { type: 'button', textContent: s });
    b.setAttribute('aria-pressed', 'false');
    b.onclick = () => {
      const on = b.getAttribute('aria-pressed') === 'true';
      $$('#sticker-row button').forEach((x) => x.setAttribute('aria-pressed', 'false'));
      b.setAttribute('aria-pressed', String(!on));
      updateWrite();
    };
    return b;
  }));
  $('#write-note').textContent = '';
  updateWrite();
  show('view-write');
}
function renderPreview(c) {
  $('#preview').replaceChildren(renderCard({ ...c, name: c.name || 'Dein Name', text: c.text || 'Dein Gruß' }, 0));
}
function currentContrib() {
  return {
    id: write.invite.id,
    name: field(writeForm, 'name').value.trim(),
    text: field(writeForm, 'text').value.trim(),
    sticker: $('#sticker-row [aria-pressed="true"]')?.textContent ?? '',
    img: write.photo ? write.photo.at(-1).img : field(writeForm, 'url').value.trim(),
  };
}
const messageFor = (name, link) => `Glückwunsch von ${name} für „${write.invite.title}“: ${link}`;
// Encodes the contribution with the best photo version (write.photo, from
// small to large) for which the whole message still fits MESSAGE_BUDGET. If
// not even the smallest fits (a very long greeting), the photo is left out;
// `tooLong` says that even the text alone does not fit.
async function fittedLink(c) {
  const linkOf = async (x) => `${BASE}#c=${await codec.encodeContrib(x)}`;
  const fits = (x, link) => utf8Length(messageFor(x.name, link)) <= MESSAGE_BUDGET;
  const ladder = write.photo;
  if (ladder) {
    let best = null;
    for (let lo = 0, hi = ladder.length - 1; lo <= hi;) {
      const mid = (lo + hi) >> 1;
      const x = { ...c, img: ladder[mid].img };
      const link = await linkOf(x);
      if (fits(x, link)) {
        best = { c: x, link };
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (best) return best;
  }
  const x = ladder ? { ...c, img: '' } : c;
  const link = await linkOf(x);
  return { c: x, link, dropped: !!ladder, tooLong: !fits(x, link) };
}
async function updateWrite() {
  const c = currentContrib();
  $('#count').textContent = field(writeForm, 'text').value.length;
  renderPreview(c);
  write.link = '';
  write.pending = null;
  write.error = '';
  $('#write-link').value = '';
  $('#size').textContent = '';
  if (!c.name || !c.text) return;
  const pending = (write.pending = fittedLink(c));
  try {
    const { c: fitted, link, dropped, tooLong } = await pending;
    if (write.pending !== pending) return; // superseded by newer input
    write.link = link;
    renderPreview(fitted); // the photo as sent
    $('#write-link').value = write.link;
    const note = tooLong ? ' · zu lang für eine Signal-Nachricht: kürzen oder als Datei senden.'
      : dropped ? ' · ohne Foto: Mit diesem langen Gruß passt es nicht in eine Nachricht.' : '';
    $('#size').textContent = `Link: ${KB(write.link.length)}${note}`;
  } catch (e) {
    if (write.pending !== pending) return;
    write.error = e.message;
    $('#size').textContent = e.message;
  }
}
const shareTextFor = () => messageFor(currentContrib().name, write.link);
// Waits for a photo still being shrunk and for the debounced recompute, so
// the link always matches what the form shows right now.
async function ensureLink() {
  if (write.shrinking) await write.shrinking.catch(() => {});
  if (write.timer) {
    clearTimeout(write.timer);
    write.timer = 0;
    await updateWrite();
  } else if (write.pending) {
    await write.pending.catch(() => {});
  }
  if (!write.link) toast(write.error || 'Bitte Name und Gruß ausfüllen.');
  return !!write.link;
}
function sent() {
  toast('Danke! Dein Gruß ist unterwegs.');
  writeForm.reset();
  write.photo = '';
  $$('#sticker-row button').forEach((x) => x.setAttribute('aria-pressed', 'false'));
  updateWrite();
}

writeForm.addEventListener('input', (e) => {
  if (e.target.name === 'url' && e.target.value) {
    write.abort?.abort(); // a link replaces a photo still being prepared
    write.shrinking = null;
    write.photo = '';
    $('#write-note').textContent = '';
  }
  clearTimeout(write.timer);
  write.timer = setTimeout(() => { write.timer = 0; updateWrite(); }, 300);
});
field(writeForm, 'photo').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  $('#write-note').textContent = 'Foto wird umgewandelt …';
  write.abort?.abort();
  const abort = (write.abort = new AbortController());
  const shrinking = (write.shrinking = photoLadder(file, abort.signal));
  try {
    const photo = await shrinking;
    if (write.shrinking !== shrinking) return; // superseded: another photo, a link, another invitation
    write.photo = photo;
    field(writeForm, 'url').value = '';
    $('#write-note').textContent = 'Foto übernommen, so klein gerechnet, dass dein Gruß in eine Nachricht passt.';
  } catch (err) {
    if (write.shrinking !== shrinking) return;
    write.photo = '';
    $('#write-note').textContent = err.message;
  } finally {
    if (write.shrinking === shrinking) write.shrinking = null;
  }
  await updateWrite();
});
writeForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!(await ensureLink())) return;
  if (navigator.share) {
    if (await shareText(shareTextFor())) sent();
  } else {
    await copyText(shareTextFor());
  }
});
$('#copy-link').onclick = async () => {
  if (await ensureLink()) await copyText(shareTextFor());
};
$('#send-file').onclick = async () => {
  if (!(await ensureLink())) return;
  const file = new File([shareTextFor()], `gruss-${slug(currentContrib().name)}.txt`, { type: 'text/plain' });
  if (canShareFiles([file])) {
    if (await shareFiles([file])) sent();
  } else {
    download(file, file.name);
  }
};

// ---- photo pipeline ---------------------------------------------------------

// A photo becomes a ladder of small JPEGs (jpeg.js, sent without header):
// every size and quality below is encoded, scored against a REF-sized copy
// by SSIM, and only versions that look better than every smaller one are
// kept. Which rung is sent depends on the room the greeting leaves
// (fittedLink). Versions too big for any message are not scored. Encoding
// through a canvas also drops EXIF data such as the location.
const REF = 240;
const SIDES = [48, 64, 80, 96, 112, 128, 160, 192, 240];
const QUALITIES = [10, 15, 20, 30, 40, 55, 70, 85];
const MAX_PHOTO = Math.floor((MESSAGE_BUDGET * 3) / 4); // bytes, before base64

function drawn(src, w, h) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff'; // transparent PNG areas become white, not black
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h).data;
}
const fit = (w, h, side) => {
  const s = Math.min(1, side / Math.max(w, h));
  return [Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s))];
};

async function photoLadder(file, signal) {
  let bmp;
  try {
    bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    bmp = await createImageBitmap(file).catch(() => { throw new Error('Das Bild kann nicht gelesen werden.'); });
  }
  const cands = [];
  try {
    const [rw, rh] = fit(bmp.width, bmp.height, Math.min(REF, MAX_SIDE));
    const ref = drawn(bmp, rw, rh);
    let last = 0;
    for (const side of SIDES) {
      const [w, h] = fit(bmp.width, bmp.height, side);
      if (w * 1000 + h === last) break; // the photo is smaller than this side
      last = w * 1000 + h;
      const px = drawn(bmp, w, h);
      if (strippedLength(encodeJpeg(px, w, h, QUALITIES[0])) > MAX_PHOTO) break; // larger sides only grow
      for (const q of QUALITIES) {
        const jpeg = encodeJpeg(px, w, h, q);
        const size = strippedLength(jpeg);
        if (size > MAX_PHOTO) break; // higher qualities only grow
        const decoded = await createImageBitmap(new Blob([jpeg], { type: 'image/jpeg' }));
        const score = ssim(ref, drawn(decoded, rw, rh), rw, rh);
        decoded.close();
        cands.push({ w, q, size, score, img: 'data:image/jpeg;base64,' + codec.toBase64(jpeg) });
      }
      signal?.throwIfAborted();
      await new Promise((r) => setTimeout(r, 0));
    }
  } finally {
    bmp.close();
  }
  cands.sort((a, b) => a.size - b.size);
  const ladder = [];
  for (const c of cands) if (!ladder.length || c.score > ladder.at(-1).score) ladder.push(c);
  if (!ladder.length) throw new Error('Das Bild kann nicht gelesen werden.');
  return ladder;
}

// ---- go ---------------------------------------------------------------------

window.addEventListener('hashchange', route);
route();
