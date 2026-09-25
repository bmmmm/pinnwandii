// SPDX-License-Identifier: GPL-3.0-or-later
// End-to-end check of pinnwandii in headless Chromium: organizer, guest with
// photo, merge, settings, finished page, viewer, mobile layout.
//
//   npm i --prefix <dir> puppeteer-core          # once, outside the repo
//   PUPPETEER_DIR=<dir> node scripts/verify-browser.mjs
//
// Without ORIGIN the repository is served from disk through request
// interception (no local port needed); ORIGIN=https://… tests a deployment.
// CHROME points to the browser binary (default: Playwright's Chromium).
// Screenshots and downloads go to OUT (default: a temp directory).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { decodeContrib, encodeBoard, encodeContrib, newId, originOf, toBase64 } from '../codec.js';
import { encodeJpeg } from '../jpeg.js';

const require = createRequire(path.join(process.env.PUPPETEER_DIR ?? process.cwd(), 'x.js'));
const puppeteer = require('puppeteer-core');
const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const LOCAL = !process.env.ORIGIN;
const ORIGIN = (process.env.ORIGIN ?? 'http://localhost:8765').replace(/\/$/, '');
const OUT = process.env.OUT ?? fs.mkdtempSync(path.join(os.tmpdir(), 'pinnwandii-verify-'));
const CHROME = process.env.CHROME ?? (() => {
  const base = path.join(os.homedir(), 'Library/Caches/ms-playwright');
  const dir = fs.readdirSync(base).filter((d) => /^chromium-\d+$/.test(d)).sort().pop();
  return path.join(base, dir, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
})();
const BUDGET = 1900; // MESSAGE_BUDGET in app.js
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
for (const d of ['shots', 'downloads', 'guest-downloads']) fs.mkdirSync(path.join(OUT, d), { recursive: true });
let failCssFetch = false; // makes fetch('style.css') answer 404 (the page's own <link> still loads)

const results = [];
const check = (name, ok, detail = '') => {
  results.push([ok, name, detail]);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
};
const consoleLog = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = (page, name) => page.screenshot({ path: path.join(OUT, 'shots', `${name}.png`) });
const utf8 = (s) => Buffer.byteLength(s, 'utf8');
async function newPage(ctx, label) {
  const page = await ctx.newPage();
  page.on('console', (m) => consoleLog.push(`[${label}] ${m.type()}: ${m.text()}`));
  page.on('pageerror', (e) => consoleLog.push(`[${label}] pageerror: ${e.message}`));
  page.on('requestfailed', (r) => consoleLog.push(`[${label}] requestfailed: ${r.url().split('#')[0]} ${r.failure()?.errorText}`));
  if (LOCAL) {
    await page.setRequestInterception(true);
    page.on('request', (r) => {
      const u = new URL(r.url());
      if (u.origin !== ORIGIN) return r.continue();
      if (failCssFetch && r.resourceType() === 'fetch' && u.pathname === '/style.css') return r.respond({ status: 404, body: 'not found' });
      const file = path.join(REPO, u.pathname === '/' ? 'index.html' : decodeURIComponent(u.pathname));
      if (!file.startsWith(REPO) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return r.respond({ status: 404, body: 'not found' });
      r.respond({ status: 200, contentType: TYPES[path.extname(file)] ?? 'application/octet-stream', body: fs.readFileSync(file) });
    });
  }
  await page.setViewport({ width: 1200, height: 900 });
  return page;
}
const setValue = (page, sel, value) => page.evaluate((sel, value) => {
  const el = document.querySelector(sel);
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}, sel, value);
const text = (page, sel) => page.$eval(sel, (e) => e.textContent);
const visible = (page, sel) => page.$eval(sel, (e) => !e.hidden && getComputedStyle(e).display !== 'none').catch(() => false);
const cardCount = (page) => page.$$eval('#wall .card', (c) => c.length);
const waitFor = (page, fn, arg, ms = 5000) => page.waitForFunction(fn, { timeout: ms }, arg);
const tokenOf = (link) => link.match(/#c=(\S+)/)?.[1];
const isPhoto = (img) => img.startsWith('data:image/jpeg;base64,');
const photoBytes = (img) => Buffer.from(img.slice(img.indexOf(',') + 1), 'base64').length;
// Decodes a photo data URI in the page: pixel at (1, 1), mean colour, and
// SSIM against `ref` (an image URL) drawn at the same size.
const inspect = (page, src, ref) => page.evaluate(async (src, ref) => {
  const { ssim } = await import(new URL('jpeg.js', document.baseURI).href); // the app may live under a path
  const load = async (u) => { const i = new Image(); i.src = u; await i.decode(); return i; };
  const img = await load(src);
  const px = (i, w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); g.drawImage(i, 0, 0, w, h); return g.getImageData(0, 0, w, h).data; };
  const a = px(img, img.width, img.height);
  const mean = [0, 1, 2].map((k) => Math.round(a.filter((_, i) => i % 4 === k).reduce((s, v) => s + v, 0) / (a.length / 4)));
  const out = { w: img.width, h: img.height, corner: [...a.slice((img.width + 1) * 4, (img.width + 1) * 4 + 3)], mean };
  if (ref) {
    const r = await load(ref);
    const b = px(r, img.width, img.height);
    out.ssim = ssim(a, b, img.width, img.height);
    out.refMean = [0, 1, 2].map((k) => Math.round(b.filter((_, i) => i % 4 === k).reduce((s, v) => s + v, 0) / (b.length / 4)));
  }
  return out;
}, src, ref);
async function contrast(page) {
  return page.evaluate(() => {
    const card = document.querySelector('#wall .card');
    const cs = getComputedStyle(card);
    const ctx = document.createElement('canvas').getContext('2d');
    const rgb = (c) => { ctx.fillStyle = c; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3); };
    const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const l1 = lum(rgb(cs.backgroundColor)), l2 = lum(rgb(cs.color));
    return Math.round(((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)) * 100) / 100;
  });
}
// Test images drawn in the page: a JPEG scene and a PNG with a transparent background.
async function makeImages(page) {
  const [jpg, png, slow] = await page.evaluate(async () => {
    const draw = (w, h, fn, type) => {
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      fn(c.getContext('2d'));
      return c.toDataURL(type, 0.9);
    };
    return [
      draw(1200, 900, (g) => {
        const sky = g.createLinearGradient(0, 0, 0, 500);
        sky.addColorStop(0, '#4a90d9'); sky.addColorStop(1, '#cfe8ff');
        g.fillStyle = sky; g.fillRect(0, 0, 1200, 900);
        g.fillStyle = '#3d8b37'; g.fillRect(0, 550, 1200, 350);
        g.fillStyle = '#ffd23f'; g.beginPath(); g.arc(950, 180, 110, 0, 7); g.fill();
        g.fillStyle = '#b5332e'; g.fillRect(250, 330, 360, 260);
        g.fillStyle = '#5a2a18'; g.beginPath(); g.moveTo(220, 340); g.lineTo(430, 170); g.lineTo(640, 340); g.fill();
      }, 'image/jpeg'),
      draw(400, 400, (g) => {
        g.fillStyle = '#1b2a6b'; g.beginPath(); g.arc(200, 200, 90, 0, 7); g.fill();
      }, 'image/png'),
      // 27 MP: its slow decode lets a smaller photo picked after it finish first
      draw(6000, 4500, (g) => {
        g.fillStyle = '#e8302a'; g.fillRect(0, 0, 3000, 4500);
        g.fillStyle = '#f5d400'; g.fillRect(3000, 0, 3000, 4500);
        for (let i = 0; i < 4000; i++) { g.fillStyle = `hsl(${i % 360},70%,50%)`; g.fillRect((i * 97) % 6000, (i * 131) % 4500, 20, 20); }
      }, 'image/jpeg'),
    ];
  });
  const save = (uri, name) => {
    const f = path.join(OUT, name);
    fs.writeFileSync(f, Buffer.from(uri.slice(uri.indexOf(',') + 1), 'base64'));
    return f;
  };
  return { jpg: save(jpg, 'scene.jpg'), png: save(png, 'transparent.png'), slow: save(slow, 'big.jpg') };
}

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true, pipe: true, protocolTimeout: 30000,
  userDataDir: fs.mkdtempSync(path.join(OUT, 'udd-')),
  args: ['--no-first-run', '--lang=de-DE', '--no-sandbox', '--disable-gpu'],
});
try {
  // ---- 1. organizer creates a board -----------------------------------------
  const org = await browser.createBrowserContext();
  await org.overridePermissions(ORIGIN, ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write']);
  const page = await newPage(org, 'org');
  const bcdp = await browser.target().createCDPSession();
  await bcdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: path.join(OUT, 'downloads'), browserContextId: org.id, eventsEnabled: true });
  await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle0' });
  check('1 start view shown', await visible(page, '#view-start'));
  const images = await makeImages(page);
  await setValue(page, '#new-form input[name=title]', 'Alles Gute zum 80., Oma!');
  await page.click('#new-form input[value=b]');
  await setValue(page, '#new-form input[name=hue]', '300');
  await page.click('#new-form button.primary');
  await waitFor(page, () => /^#o=[A-Za-z0-9_-]{6}$/.test(location.hash));
  const boardId = await page.evaluate(() => location.hash.slice(3));
  check('1 board created, #o= route', await visible(page, '#view-board') && await visible(page, '#toolbar'), `id ${boardId}`);
  check('1 empty wall hint', await visible(page, '#empty') && (await cardCount(page)) === 0);
  check('1 theme applied', await page.evaluate(() => document.body.dataset.preset === 'b' && document.body.style.getPropertyValue('--hue') === '300' && document.title === 'Alles Gute zum 80., Oma!'));
  await shot(page, '01-board-empty');

  // ---- 2. invite -> guest writes with a photo ---------------------------------
  await page.click('#toolbar [data-act=invite]');
  await waitFor(page, () => document.querySelector('#dlg-share').open);
  const inviteText = await page.$eval('#share-text', (e) => e.value);
  const inviteLink = inviteText.match(/https?:\/\/\S+#i=\S+/)?.[0];
  check('2 invite link ~120 chars', !!inviteLink && inviteLink.length < 200, `${inviteLink?.length} chars`);
  await page.click('#dlg-share [data-close]');

  const guestCtx = await browser.createBrowserContext();
  await guestCtx.overridePermissions(ORIGIN, ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write']);
  const guest = await newPage(guestCtx, 'guest');
  // a messenger's tracking parameter must not ride along into the reply link
  await guest.goto(inviteLink.replace('#i=', '?fbclid=XYZ#i='), { waitUntil: 'networkidle0' });
  check('2 write view with invite title', await visible(guest, '#view-write') && (await text(guest, '#title')) === 'Alles Gute zum 80., Oma!');
  await setValue(guest, '#write-form input[name=name]', 'Anna Müller');
  await setValue(guest, '#write-form textarea[name=text]', 'Liebe Oma, alles Gute! 🎉\nWir feiern bald zusammen.');
  await guest.click('#sticker-row button:nth-child(2)');
  const photoInput = await guest.$('#write-form input[name=photo]');
  const t0 = Date.now();
  await photoInput.uploadFile(images.jpg);
  await waitFor(guest, () => document.querySelector('#write-note').textContent.startsWith('Foto übernommen'), null, 20000);
  const photoMs = Date.now() - t0;
  await waitFor(guest, () => document.querySelector('#write-link').value.length > 100);
  const guestLink = await guest.$eval('#write-link', (e) => e.value);
  const guestMsg = `Glückwunsch von Anna Müller für „Alles Gute zum 80., Oma!“: ${guestLink}`;
  const sent = await decodeContrib(tokenOf(guestLink));
  await waitFor(guest, () => document.querySelector('#preview .card img')?.complete);
  check('2 preview shows the photo + sticker', await guest.evaluate(() => document.querySelector('#preview .card img[src^="data:image/jpeg"]')?.naturalWidth > 0 && document.querySelector('#preview .card .sticker')?.textContent === '🎂'));
  const sentLook = isPhoto(sent.img) ? await inspect(guest, sent.img, `data:image/jpeg;base64,${fs.readFileSync(images.jpg).toString('base64')}`) : {};
  check('2 link carries the photo, version 3, no query string', isPhoto(sent.img) && guestLink.includes('/#c=3.') && !guestLink.includes('?'), `${sentLook.w}×${sentLook.h} px, ${photoBytes(sent.img)} B as JPEG, ${photoMs} ms`);
  check('2 photo in the link looks like the original (SSIM, colours)', sentLook.ssim > 0.7 && sentLook.mean.every((v, k) => Math.abs(v - sentLook.refMean[k]) < 12), `ssim ${sentLook.ssim?.toFixed(3)}, mean ${sentLook.mean} vs ${sentLook.refMean}`);
  check(`2 whole message ≤ ${BUDGET} bytes (one Signal message)`, utf8(guestMsg) <= BUDGET, `${utf8(guestMsg)} bytes, size line "${await text(guest, '#size')}"`);
  await shot(guest, '02-write');
  await bcdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: path.join(OUT, 'guest-downloads'), browserContextId: guestCtx.id, eventsEnabled: true });
  await guest.evaluate(() => { navigator.canShare = () => false; }); // take the download path
  await guest.$eval('#send-file', (b) => b.click());
  const sendFile = path.join(OUT, 'guest-downloads', 'gruss-anna-muller.txt');
  for (let i = 0; i < 50 && !fs.existsSync(sendFile); i++) await sleep(100);
  check('2 "Als Datei senden": file name without combining marks', fs.existsSync(sendFile) && fs.readFileSync(sendFile, 'utf8').includes('#c=3.'), fs.readdirSync(path.join(OUT, 'guest-downloads')).join(', '));

  // long text: fewer triangles, still one message
  await guest.evaluate(() => { window.__copied = null; navigator.clipboard.writeText = (t) => { window.__copied = t; return Promise.resolve(); }; });
  const longText = 'Liebe Oma, wir denken an dich und wünschen dir alles Gute! '.repeat(17).slice(0, 1000);
  await setValue(guest, '#write-form textarea[name=text]', longText);
  await guest.$eval('#copy-link', (b) => b.click()); // DOM click: the #size line above the buttons empties and refills while encoding
  await waitFor(guest, () => typeof window.__copied === 'string');
  const longMsg = await guest.evaluate(() => window.__copied);
  const longSent = await decodeContrib(tokenOf(longMsg));
  check(`2 1000-char text + photo: message ≤ ${BUDGET} bytes, photo kept, not larger`, utf8(longMsg) <= BUDGET && longSent.text === longText && isPhoto(longSent.img) && photoBytes(longSent.img) <= photoBytes(sent.img), `${utf8(longMsg)} bytes, photo ${photoBytes(longSent.img)} B`);
  const previewSrc = await guest.$eval('#preview .card img', (e) => e.src);
  check('2 preview shows the photo version that is sent', previewSrc === longSent.img);
  // a greeting that leaves no room at all: the photo is left out, visibly
  let cjkSeed = 11;
  const cjk = Array.from({ length: 1000 }, () => String.fromCharCode(0x4e00 + ((cjkSeed = (cjkSeed * 1664525 + 1013904223) >>> 0) % 0x5000))).join('');
  const sendText = async (t) => {
    await setValue(guest, '#write-form textarea[name=text]', t);
    await guest.evaluate(() => { window.__copied = null; });
    await guest.$eval('#copy-link', (b) => b.click());
    await waitFor(guest, () => typeof window.__copied === 'string');
    const msg = await guest.evaluate(() => window.__copied);
    return { msg, c: await decodeContrib(tokenOf(msg)), size: await text(guest, '#size') };
  };
  let mid, n = 500; // grow the text until no photo version fits any more
  do mid = await sendText(cjk.slice(0, (n += 10))); while (mid.c.img !== '' && n < 1000);
  check('2 no room for the photo: sent without it, and the page says so', mid.c.img === '' && utf8(mid.msg) <= BUDGET && mid.size.includes('ohne Foto'), `${n} chars, ${utf8(mid.msg)} bytes; ${mid.size}`);
  const long = await sendText(cjk); // 3000 bytes that do not compress
  check('2 text alone too long for Signal: the page says so', long.c.img === '' && utf8(long.msg) > BUDGET && long.size.includes('zu lang für eine Signal-Nachricht'), long.size);
  await setValue(guest, '#write-form textarea[name=text]', 'Liebe Oma, alles Gute! 🎉\nWir feiern bald zusammen.');

  // ---- 3. copy link -> organizer receives -------------------------------------
  await guest.bringToFront();
  await guest.evaluate(() => { window.__copied = null; });
  await guest.$eval('#copy-link', (b) => b.click()); // DOM click: the #size line above the buttons empties and refills while encoding
  await waitFor(guest, () => typeof window.__copied === 'string');
  check('3 copy link: toast confirms clipboard write', (await text(guest, '#toast')) === 'Kopiert.', await text(guest, '#toast'));
  const copiedLink = (await guest.evaluate(() => window.__copied)).match(/https?:\/\/\S+#c=\S+/)[0];
  await page.bringToFront();
  await page.goto(copiedLink, { waitUntil: 'networkidle0' });
  await waitFor(page, (id) => location.hash === `#o=${id}`, boardId);
  await sleep(300);
  check('3 contribution merged, card with photo', (await cardCount(page)) === 1 && await page.evaluate(() => !!document.querySelector('#wall .card img[src^="data:image/jpeg"]')));
  check('3 toast shown', await page.evaluate(() => document.querySelector('#toast').textContent.includes('übernommen (1)')), await text(page, '#toast'));
  await shot(page, '03-received');

  // transparent PNG: transparent areas turn white, not black
  await guest.bringToFront();
  await photoInput.uploadFile(images.png);
  await waitFor(guest, () => document.querySelector('#write-note').textContent.startsWith('Foto übernommen'), null, 20000);
  await waitFor(guest, () => document.querySelector('#write-link').value.length > 100);
  const pngSent = await decodeContrib(tokenOf(await guest.$eval('#write-link', (e) => e.value)));
  const bg = isPhoto(pngSent.img) ? (await inspect(guest, pngSent.img)).corner : [];
  check('3 transparent PNG: transparent areas are light', bg.length === 3 && bg.every((v) => v > 200), `corner ${bg}`);

  // a first photo that is slower to read must not override the photo picked after it
  await photoInput.uploadFile(images.slow);
  await photoInput.uploadFile(images.jpg);
  await waitFor(guest, () => document.querySelector('#write-note').textContent.startsWith('Foto übernommen'), null, 20000);
  await sleep(4000); // time for the big photo to finish if it is not stopped
  const lastSent = await decodeContrib(tokenOf(await guest.$eval('#write-link', (e) => e.value)));
  check('3 photo picked last wins over a slower earlier one', lastSent.img === sent.img, `mean ${isPhoto(lastSent.img) ? (await inspect(guest, lastSent.img)).mean : 'no photo'}`);

  // ---- P1-3: "Senden" right after typing must ship the current text ---------
  await guest.evaluate(() => { window.__copied = null; });
  await setValue(guest, '#write-form textarea[name=text]', 'Neuer Text, sofort gesendet.');
  await guest.$eval('#copy-link', (b) => b.click()); // DOM click: the #size line above the buttons empties and refills while encoding // no wait: the 300 ms debounce is still pending
  await waitFor(guest, () => typeof window.__copied === 'string');
  const copiedTok = tokenOf(await guest.evaluate(() => window.__copied));
  const decoded = copiedTok ? await decodeContrib(copiedTok).catch((e) => ({ text: 'ERR ' + e.message })) : { text: 'no token' };
  check('P1-3 copied link carries the just-typed text', decoded.text === 'Neuer Text, sofort gesendet.', decoded.text);

  // ---- P1-1: a second tab saves the same board ---------------------------------
  const zedLink = `${ORIGIN}/#c=${await encodeContrib({ id: boardId, name: 'Zed', text: 'Aus dem zweiten Tab', sticker: '', img: '' })}`;
  const tabB = await newPage(org, 'tabB');
  await tabB.goto(zedLink, { waitUntil: 'networkidle0' });
  await waitFor(tabB, (id) => location.hash === `#o=${id}`, boardId);
  await waitFor(page, () => document.querySelectorAll('#wall .card').length === 2);
  check('P1-1 tab A follows the save from tab B (storage event)', (await cardCount(page)) === 2);
  await page.bringToFront(); // a click in a background tab hangs (IntersectionObserver never fires)
  await page.click('#toolbar [data-act=settings]');
  await waitFor(page, () => document.querySelector('#dlg-settings').open);
  await setValue(page, '#settings-form input[name=hue]', '77'); // input + change -> save from tab A
  await page.click('#dlg-settings [data-close]');
  await page.reload({ waitUntil: 'networkidle0' });
  await sleep(200);
  check('P1-1 tab A save keeps tab B\'s post and its own hue', (await cardCount(page)) === 2 && await page.evaluate(() => document.body.style.getPropertyValue('--hue') === '77'));
  await tabB.close();
  await page.bringToFront();
  await page.click('#toolbar [data-act=merge]');
  await waitFor(page, () => document.querySelector('#dlg-merge').open);
  await page.evaluate(() => [...document.querySelectorAll('#merge-list li')].find((li) => li.textContent.includes('Zed')).querySelector('button.x').click());
  await waitFor(page, () => document.querySelector('#dlg-confirm').open);
  await page.click('#confirm-ok');
  await waitFor(page, () => document.querySelectorAll('#wall .card').length === 1);
  check('P1-1 delete via confirm dialog removes exactly that post', (await cardCount(page)) === 1 && !(await page.evaluate(() => document.querySelector('#merge-list').textContent.includes('Zed'))));
  await page.click('#dlg-merge [data-close]');

  // ---- 4. merge dialog: paste chat export, then same file ------------------------
  const mk = (name, id = boardId) => encodeContrib({ id, name, text: `Gruß von ${name} 🎈`, sticker: '🎈', img: '' });
  const [tA, tB, tC, tF] = await Promise.all([mk('Ben'), mk('Chris'), mk('Dana'), mk('Fremd', 'zzzzzz')]);
  const wrap = (t) => t.slice(0, 40) + '\r\n' + t.slice(40, 80) + '\n' + t.slice(80);
  const chat = [
    `[25.09.26, 12:01] Ben: Glückwunsch von Ben für „Oma“: ${ORIGIN}/#c=${tA}`,
    `[25.09.26, 12:02] Chris: ${ORIGIN}/#c=${wrap(tB)}`,
    'Liebe Grüße',
    `25.09.26, 12:03 - Dana: ${ORIGIN}/#c=${tC}`,
    `[25.09.26, 12:04] Ben: nochmal ${ORIGIN}/#c=${tA}`,
    `[25.09.26, 12:05] Fremd: ${ORIGIN}/#c=${tF}`,
    `[25.09.26, 12:06] Emil: ${ORIGIN}/#c=${tB.slice(0, 40)}`,
    '[25.09.26, 12:07] Oma: 1. November feiern wir alle zusammen bei mir im Garten, ab 15 Uhr',
  ].join('\n');
  const chatFile = path.join(OUT, 'chat-export.txt');
  fs.writeFileSync(chatFile, chat);
  await page.click('#toolbar [data-act=merge]');
  await waitFor(page, () => document.querySelector('#dlg-merge').open);
  await setValue(page, '#merge-text', chat);
  await page.click('#merge-go');
  await waitFor(page, () => document.querySelector('#merge-result').textContent.length > 0);
  const r1 = await text(page, '#merge-result');
  check('4 merge result line', r1 === '3 übernommen, 1 doppelt, 1 fremde Pinnwand, 1 defekt', r1);
  check('4 four cards', (await cardCount(page)) === 4);
  await (await page.$('#merge-files')).uploadFile(chatFile);
  await waitFor(page, () => document.querySelector('#merge-result').textContent.startsWith('0 '));
  const r2 = await text(page, '#merge-result');
  // the export lists Ben's link twice, so both count as duplicates now
  check('4 same file again: all duplicates', r2 === '0 übernommen, 4 doppelt, 1 fremde Pinnwand, 1 defekt', r2);
  check('4 list shows 4 entries with delete buttons', (await page.$$eval('#merge-list li button.x', (b) => b.length)) === 4);
  await shot(page, '04-merge');
  await page.click('#dlg-merge [data-close]');

  // ---- 5. settings: presets, admin link, backup ------------------------------------
  await page.click('#toolbar [data-act=settings]');
  await waitFor(page, () => document.querySelector('#dlg-settings').open);
  const ratios = {};
  for (const p of ['p', 'b', 'd']) {
    await page.click(`#settings-form input[value=${p}]`);
    await sleep(100);
    ratios[p] = await contrast(page);
    await page.evaluate(() => document.querySelector('#dlg-settings').close());
    await shot(page, `05-preset-${p}`);
    await page.evaluate(() => document.querySelector('#dlg-settings').showModal());
  }
  check('5 contrast ≥ 4.5 in all presets', Object.values(ratios).every((r) => r >= 4.5), JSON.stringify(ratios));
  await page.click('#settings-form input[value=b]');
  await setValue(page, '#settings-form input[name=hue]', '40');
  await sleep(100);
  check('5 hue live', await page.evaluate(() => document.body.style.getPropertyValue('--hue') === '40'));
  await page.click('#admin-link');
  await waitFor(page, () => document.querySelector('#dlg-share').open);
  const adminLink = await page.$eval('#share-text', (e) => e.value);
  check('5 admin link offered', adminLink.startsWith(`${ORIGIN}/#b=3.`) && adminLink.length < 32000, `${adminLink.length} chars`);
  await page.click('#dlg-share [data-close]');
  const dev2Ctx = await browser.createBrowserContext();
  const dev2 = await newPage(dev2Ctx, 'dev2');
  await dev2.goto(adminLink, { waitUntil: 'networkidle0' });
  await waitFor(dev2, (id) => location.hash === `#o=${id}`, boardId);
  await sleep(200);
  check('5 admin link on fresh device: 4 cards, organizer view', (await cardCount(dev2)) === 4 && await visible(dev2, '#toolbar') && await dev2.evaluate(() => document.body.dataset.preset === 'b'));
  await page.bringToFront();
  await page.click('#backup');
  const backupPath = path.join(OUT, 'downloads', `pinnwand-${boardId}.json`);
  for (let i = 0; i < 50 && !fs.existsSync(backupPath); i++) await sleep(100);
  check('5 backup downloaded', fs.existsSync(backupPath), backupPath);
  await page.click('#dlg-settings [data-close]');
  await page.click('#toolbar [data-act=merge]');
  await waitFor(page, () => document.querySelector('#dlg-merge').open);
  await (await page.$('#merge-files')).uploadFile(backupPath);
  await waitFor(page, () => document.querySelector('#merge-result').textContent.length > 0);
  const r3 = await text(page, '#merge-result');
  check('5 backup re-import: all duplicates', r3 === '0 übernommen, 4 doppelt, 0 fremde Pinnwand, 0 defekt', r3);
  await page.click('#dlg-merge [data-close]');

  // ---- 6. finished page: preview tab and download ------------------------------------
  await page.click('#toolbar [data-act=build]');
  await waitFor(page, () => document.querySelector('#dlg-build').open);
  const popupPromise = new Promise((r) => browser.once('targetcreated', (t) => r(t)));
  await page.click('#build-preview');
  const preview = await (await popupPromise).page();
  preview.on('pageerror', (e) => consoleLog.push(`[preview] pageerror: ${e.message}`));
  await preview.waitForSelector('.card');
  const pv = await preview.evaluate(() => ({
    cards: document.querySelectorAll('.card').length,
    photo: !!document.querySelector('.card img[src^="data:image/jpeg"]'),
    photoDrawn: document.querySelector('.card img[src^="data:image/jpeg"]')?.naturalWidth > 0,
    scripts: document.querySelectorAll('script').length,
    preset: document.body.dataset.preset, hue: document.body.style.getPropertyValue('--hue'),
    styled: getComputedStyle(document.querySelector('.card')).borderRadius !== '0px',
    blob: location.protocol === 'blob:',
  }));
  check('6 preview tab: 4 cards, photo drawn, no script, themed, styled', pv.cards === 4 && pv.photo && pv.photoDrawn && pv.scripts === 0 && pv.preset === 'b' && pv.hue === '40' && pv.styled && pv.blob, JSON.stringify(pv));
  await shot(preview, '06-preview');
  await preview.close();
  await page.bringToFront();
  await page.click('#build-download');
  const htmlPath = path.join(OUT, 'downloads', `pinnwand-${boardId}.html`);
  for (let i = 0; i < 50 && !fs.existsSync(htmlPath); i++) await sleep(100);
  check('6 html downloaded', fs.existsSync(htmlPath), htmlPath);
  const html = fs.readFileSync(htmlPath, 'utf8');
  check('6 html file: doctype, CSP meta, no <script, no edit buttons', html.startsWith('<!doctype html>') && html.includes('Content-Security-Policy') && !/<script/i.test(html) && !html.includes('class="edit"'));
  const filePage = await org.newPage();
  await filePage.goto(`file://${htmlPath}`, { waitUntil: 'load' });
  await waitFor(filePage, () => document.querySelector('.card img')?.complete).catch(() => {}); // lazy image
  check('6 file:// renders 4 cards with the photo', await filePage.evaluate(() => document.querySelectorAll('.card').length === 4 && document.querySelector('.card img[src^="data:image/jpeg"]')?.naturalWidth > 0 && getComputedStyle(document.querySelector('.card')).borderRadius !== '0px'));
  await shot(filePage, '06-file');
  await filePage.close();
  await page.bringToFront();
  // the preview's blob URL is released (60 s timer, sped up here)
  await page.evaluate(() => {
    window.__revoked = [];
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = (u) => { window.__revoked.push(u); revoke(u); };
    const later = window.setTimeout.bind(window);
    window.setTimeout = (fn, ms, ...a) => later(fn, ms === 60_000 ? 300 : ms, ...a);
  });
  const popup2 = new Promise((r) => browser.once('targetcreated', (t) => r(t)));
  await page.click('#build-preview');
  const previewUrl = (await popup2).url();
  await sleep(600);
  check('6 preview blob URL is revoked', previewUrl.startsWith('blob:') && (await page.evaluate(() => window.__revoked)).includes(previewUrl), previewUrl);
  for (const p of await browser.pages()) if (p.url().startsWith('blob:')) await p.close();
  await page.bringToFront();
  await page.click('#dlg-build [data-close]');
  if (LOCAL) {
    const cssPage = await newPage(org, 'css404');
    await cssPage.goto(`${ORIGIN}/#o=${boardId}`, { waitUntil: 'networkidle0' });
    failCssFetch = true;
    await cssPage.click('#toolbar [data-act=build]');
    await waitFor(cssPage, () => document.querySelector('#dlg-build').open);
    await sleep(300);
    await cssPage.evaluate(() => { document.querySelector('#toast').textContent = ''; });
    await cssPage.$eval('#build-download', (b) => b.click());
    await sleep(500);
    const cssToast = await text(cssPage, '#toast');
    failCssFetch = false;
    check('6 stylesheet 404: toast instead of a page without styles', cssToast === 'Stylesheet nicht ladbar, bitte Seite neu laden.', cssToast);
    await cssPage.close();
    await page.bringToFront();
  }

  // ---- 7. viewer link and broken link --------------------------------------------------
  const viewLink = adminLink.replace('#b=', '#v=');
  await dev2.bringToFront();
  await dev2.goto(viewLink, { waitUntil: 'networkidle0' });
  await sleep(200);
  check('7 #v= viewer: 4 cards, no toolbar, no edit buttons', (await cardCount(dev2)) === 4 && !(await visible(dev2, '#toolbar')) && !(await dev2.$('#wall .card .edit')));
  await dev2.goto(adminLink.slice(0, -40), { waitUntil: 'networkidle0' });
  await sleep(200);
  const errText = await text(dev2, '#error-text');
  check('7 truncated link -> error view with text, hash kept', await visible(dev2, '#view-error') && errText.length > 10 && await dev2.evaluate(() => location.hash.startsWith('#b=')), errText);
  await shot(dev2, '07-error');
  await dev2.goto(`${ORIGIN}/#i=9.abc`, { waitUntil: 'networkidle0' });
  check('7 newer version -> error', (await text(dev2, '#error-text')).includes('neueren Version'));
  await dev2.close();

  // ---- 9. mobile viewport ----------------------------------------------------------------
  await page.bringToFront();
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await page.reload({ waitUntil: 'networkidle0' });
  await sleep(300);
  const mob = await page.evaluate(() => {
    // offsetLeft ignores the decorative rotation; bounding boxes of rotated cards differ by a few px
    const lefts = [...document.querySelectorAll('#wall .card')].map((c) => c.offsetLeft);
    const btns = [...document.querySelectorAll('#toolbar button')].map((b) => b.getBoundingClientRect());
    return {
      innerWidth, scrollWidth: document.documentElement.scrollWidth,
      oneColumn: new Set(lefts).size === 1,
      buttonsInside: btns.every((r) => r.left >= 0 && r.right <= innerWidth && r.width > 0),
    };
  });
  check('9 390px: one column, no horizontal scroll, buttons reachable', mob.innerWidth === 390 && mob.scrollWidth <= 390 && mob.oneColumn && mob.buttonsInside, JSON.stringify(mob));
  await shot(page, '09-mobile');
  await page.setViewport({ width: 1200, height: 900 });

  // ---- 10. fifty-card board --------------------------------------------------------------
  const words = 'alles gute liebe oma wir wünschen dir gesundheit glück freude und viele schöne jahre bleib wie du bist danke für alles'.split(' ');
  let seed = 7;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0);
  const big = { id: newId(), title: 'Fünfzig Grüße', preset: 'p', hue: 120, contribs: Array.from({ length: 50 }, (_, i) => {
    let t = '';
    while (t.length < 120 + (rnd() % 160)) t += words[rnd() % words.length] + ' ';
    return { name: `Person ${i + 1}`, text: t.trim(), sticker: i % 4 ? '🎉' : '', img: '' };
  }) };
  const bigLink = `${ORIGIN}/#b=${await encodeBoard(big)}`;
  const bigCtx = await browser.createBrowserContext();
  const bigPage = await newPage(bigCtx, 'big');
  await bigPage.goto(bigLink, { waitUntil: 'networkidle0' });
  await waitFor(bigPage, () => location.hash.startsWith('#o=') && document.querySelector('#meta').textContent.includes('Admin-Link'));
  const meta = await text(bigPage, '#meta');
  check('10 fifty cards + meta line', (await cardCount(bigPage)) === 50 && /^50 Beiträge · Admin-Link: \d+,\d KB$/.test(meta) && bigLink.length < 12000, `${meta}; link ${bigLink.length} chars`);
  await shot(bigPage, '10-fifty');
  await bigPage.close();

  // ---- 11. a full board: merge and receive report instead of failing -------------
  const fullBoard = { id: newId(), title: 'Voll', preset: 'p', hue: 10, contribs: Array.from({ length: 500 }, (_, i) => ({ name: `P${i}`, text: 'x', sticker: '', img: '' })) };
  const fullCtx = await browser.createBrowserContext();
  const fullPage = await newPage(fullCtx, 'full');
  await fullPage.goto(`${ORIGIN}/#b=${await encodeBoard(fullBoard)}`, { waitUntil: 'networkidle0' });
  await waitFor(fullPage, () => location.hash.startsWith('#o='));
  const extra = await encodeContrib({ id: fullBoard.id, name: 'Zu spät', text: 'Noch einer', sticker: '', img: '' });
  await fullPage.click('#toolbar [data-act=merge]');
  await waitFor(fullPage, () => document.querySelector('#dlg-merge').open);
  await setValue(fullPage, '#merge-text', `${ORIGIN}/#c=${extra}`);
  await fullPage.click('#merge-go');
  await waitFor(fullPage, () => document.querySelector('#merge-result').textContent.length > 0);
  const rFull = await text(fullPage, '#merge-result');
  check('11 full board: merge reports the rest', rFull === '0 übernommen, 0 doppelt, 0 fremde Pinnwand, 0 defekt. 1 nicht übernommen: Pinnwand voll (höchstens 500).', rFull);
  await fullPage.goto(`${ORIGIN}/#c=${extra}`, { waitUntil: 'networkidle0' });
  await sleep(200);
  const hintFull = await text(fullPage, '#receive-hint');
  check('11 full board: receive view says so, board unchanged', await visible(fullPage, '#view-receive') && hintFull.includes('voll') && await fullPage.evaluate((id) => JSON.parse(localStorage.getItem(`pinnwandii:${id}`))[4].length === 500, fullBoard.id), hintFull);
  await fullPage.close();

  // ---- 12. a late settings "change" lands on the board it was made for -------------------
  const mkBoard = (title) => ({ id: newId(), title, preset: 'p', hue: 200, contribs: [] });
  const [bA, bB] = [mkBoard('Erste'), mkBoard('Zweite')];
  const multiCtx = await browser.createBrowserContext();
  const multi = await newPage(multiCtx, 'multi');
  for (const b of [bB, bA]) {
    await multi.goto(`${ORIGIN}/#b=${await encodeBoard(b)}`, { waitUntil: 'networkidle0' });
    await waitFor(multi, (id) => location.hash === `#o=${id}`, b.id);
  }
  await multi.click('#toolbar [data-act=settings]');
  await waitFor(multi, () => document.querySelector('#dlg-settings').open);
  await multi.evaluate(() => {
    const t = document.querySelector('#settings-form input[name=title]');
    t.value = 'Erste, neu';
    t.dispatchEvent(new Event('input', { bubbles: true })); // typed, not yet committed
  });
  await multi.evaluate((id) => { location.hash = `#o=${id}`; }, bB.id);
  await waitFor(multi, () => !document.querySelector('#dlg-settings').open && document.title === 'Zweite');
  await multi.evaluate(() => document.querySelector('#settings-form input[name=title]').dispatchEvent(new Event('change', { bubbles: true })));
  const titles = await multi.evaluate((a, b) => [a, b].map((id) => JSON.parse(localStorage.getItem(`pinnwandii:${id}`))[1]), bA.id, bB.id);
  check('12 late settings change: saved on its own board, other board untouched', titles[0] === 'Erste, neu' && titles[1] === 'Zweite' && (await text(multi, '#title')) === 'Zweite', JSON.stringify(titles));
  await multi.close();

  // ---- 13. a browser without Compression Streams gets a clear message ------------------
  const oldCtx = await browser.createBrowserContext();
  const old = await newPage(oldCtx, 'old');
  await old.evaluateOnNewDocument(() => { delete window.CompressionStream; delete window.DecompressionStream; });
  await old.goto(inviteLink, { waitUntil: 'networkidle0' });
  const oldText = await text(old, '#error-text');
  check('13 no Compression Streams: "zu alt" message', await visible(old, '#view-error') && oldText.includes('zu alt'), oldText);
  await old.close();

  // ---- 14. curating: edit, remove photo, move, delete; merging again changes nothing -----
  const cur = { id: newId(), title: 'Kuratieren', preset: 'p', hue: 90, contribs: [], deleted: [] };
  const px = new Uint8Array(32 * 24 * 4).map((_, i) => (i % 4 === 3 ? 255 : (i * 13) & 255));
  const pic = 'data:image/jpeg;base64,' + toBase64(encodeJpeg(px, 32, 24, 50));
  const curToks = await Promise.all([['Anna', pic], ['Ben', ''], ['Cleo', ''], ['Dora', '']].map(([name, img]) => encodeContrib({ id: cur.id, name, text: `Gruß von ${name}`, sticker: '', img })));
  const curChat = curToks.map((t, i) => `[25.09.26, 13:0${i}] G${i}: ${ORIGIN}/#c=${t}`).join('\n');
  const curCtx = await browser.createBrowserContext();
  const cp = await newPage(curCtx, 'cur');
  await cp.goto(`${ORIGIN}/#b=${await encodeBoard(cur)}`, { waitUntil: 'networkidle0' });
  await waitFor(cp, (id) => location.hash === `#o=${id}`, cur.id);
  const pasteChat = async () => {
    await cp.click('#toolbar [data-act=merge]');
    await waitFor(cp, () => document.querySelector('#dlg-merge').open);
    await setValue(cp, '#merge-text', curChat);
    await cp.evaluate(() => { document.querySelector('#merge-result').textContent = ''; });
    await cp.click('#merge-go');
    await waitFor(cp, () => document.querySelector('#merge-result').textContent.length > 0);
    const r = await text(cp, '#merge-result');
    await cp.click('#dlg-merge [data-close]');
    return r;
  };
  check('14 four posts collected', (await pasteChat()) === '4 übernommen, 0 doppelt, 0 fremde Pinnwand, 0 defekt');
  const storedShape = () => cp.evaluate((id) => { const t = JSON.parse(localStorage.getItem(`pinnwandii:${id}`)); return [t.length, ...t[4].map((e) => e.length)].join(); }, cur.id);
  check('14 uncurated board is stored in the pre-version-3 shape', (await storedShape()) === '5,4,4,4,4', await storedShape());
  const openCard = async (name) => {
    await cp.$eval(`#wall .card button.edit[title="Beitrag von ${name} bearbeiten"]`, (b) => b.click());
    await waitFor(cp, () => document.querySelector('#dlg-card').open);
  };
  await openCard('Ben');
  await shot(cp, '14-card-dialog');
  await setValue(cp, '#card-form textarea[name=text]', 'Gruß von Ben, korrigiert');
  await cp.$eval('#card-stickers button:nth-child(3)', (b) => b.click());
  await cp.$eval('#card-save', (b) => b.click());
  await openCard('Anna');
  const photoShown = await visible(cp, '#card-nophoto');
  const boxWidth = await cp.$eval('#card-form input[name=nophoto]', (b) => b.getBoundingClientRect().width);
  await cp.$eval('#card-form input[name=nophoto]', (b) => b.click());
  await cp.$eval('#card-save', (b) => b.click());
  await openCard('Dora');
  await cp.$eval('#card-earlier', (b) => b.click());
  await cp.$eval('#card-earlier', (b) => b.click()); // twice: Dora ends up before Ben
  await cp.$eval('#dlg-card [data-close]', (b) => b.click());
  await openCard('Cleo');
  await cp.$eval('#card-delete', (b) => b.click());
  await waitFor(cp, () => document.querySelector('#dlg-confirm').open);
  await cp.$eval('#confirm-ok', (b) => b.click());
  await waitFor(cp, () => document.querySelectorAll('#wall .card').length === 3);
  await openCard('Anna');
  await setValue(cp, '#card-form input[name=name]', 'Anna M.');
  await cp.focus('#card-form input[name=name]');
  await cp.keyboard.press('Enter');
  await waitFor(cp, () => !document.querySelector('#dlg-card').open);
  const wallState = () => cp.$$eval('#wall .card', (cs) => cs.map((c) => [c.querySelector('.name').textContent, c.querySelector('.text').textContent, c.querySelector('.sticker')?.textContent ?? '', !!c.querySelector('img')]));
  const expected = JSON.stringify([['Anna M.', 'Gruß von Anna', '', false], ['Dora', 'Gruß von Dora', '', false], ['Ben', 'Gruß von Ben, korrigiert', '🎈', false]]);
  const afterEdit = JSON.stringify(await wallState());
  await shot(cp, '14-curated');
  check('14 edit text + sticker, remove photo, move, delete, Enter saves', photoShown && afterEdit === expected, afterEdit);
  check('14 "Foto entfernen" is a plain checkbox, not a stretched field', boxWidth > 0 && boxWidth < 40, `${boxWidth}px`);
  check('14 curated board is stored with origins and deletions', (await storedShape()).startsWith('6,'), await storedShape());
  const again = await pasteChat();
  const afterMerge = JSON.stringify(await wallState());
  check('14 same chat again: nothing comes back, edits stay', again === '0 übernommen, 4 doppelt, 0 fremde Pinnwand, 0 defekt' && afterMerge === expected, `${again}; ${afterMerge}`);
  await cp.click('#toolbar [data-act=settings]');
  await waitFor(cp, () => document.querySelector('#dlg-settings').open);
  await cp.click('#admin-link');
  await waitFor(cp, () => document.querySelector('#dlg-share').open);
  const curAdmin = await cp.$eval('#share-text', (e) => e.value);
  await cp.close();
  const cur2Ctx = await browser.createBrowserContext();
  const cp2 = await newPage(cur2Ctx, 'cur2');
  await cp2.goto(curAdmin, { waitUntil: 'networkidle0' });
  await waitFor(cp2, (id) => location.hash === `#o=${id}`, cur.id);
  await cp2.click('#toolbar [data-act=merge]');
  await waitFor(cp2, () => document.querySelector('#dlg-merge').open);
  await setValue(cp2, '#merge-text', curChat);
  await cp2.click('#merge-go');
  await waitFor(cp2, () => document.querySelector('#merge-result').textContent.length > 0);
  const r2dev = await text(cp2, '#merge-result');
  check('14 second device via admin link: the deletion travels along', r2dev === '0 übernommen, 4 doppelt, 0 fremde Pinnwand, 0 defekt' && (await cardCount(cp2)) === 3, r2dev);
  // a file that deletes a post (crafted or from another device) asks first
  const killer = JSON.stringify([cur.id, 'x', 'p', 1, [], [originOf({ name: 'Dora', text: 'Gruß von Dora', sticker: '', img: '' })]]);
  const pasteKiller = async (answer) => {
    await setValue(cp2, '#merge-text', killer);
    await cp2.evaluate(() => { document.querySelector('#merge-result').textContent = ''; });
    await cp2.$eval('#merge-go', (b) => b.click());
    await waitFor(cp2, () => document.querySelector('#dlg-confirm').open);
    const q = await text(cp2, '#confirm-text');
    await cp2.$eval(answer, (b) => b.click());
    await waitFor(cp2, () => document.querySelector('#merge-result').textContent.length > 0);
    return [q, await text(cp2, '#merge-result'), await cardCount(cp2)];
  };
  const [q1, keep, n1] = await pasteKiller('#confirm-cancel');
  check('14 deletions from a file: asked by name, "Abbrechen" keeps the card', q1.includes('Dora') && n1 === 3 && !keep.includes('gelöscht'), `${q1} → ${keep}`);
  const [, del, n2] = await pasteKiller('#confirm-ok');
  check('14 deletions from a file: "Löschen" deletes and says so', n2 === 2 && del.includes('1 gelöscht'), del);
  await cp2.close();

  // ---- start page lists saved boards -------------------------------------------------------
  await page.bringToFront();
  await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle0' });
  check('start lists saved board', await page.$$eval('#saved li a', (a) => a.map((x) => x.textContent)).then((t) => t.includes('Alles Gute zum 80., Oma!')));
} catch (e) {
  check('script completed without exception', false, e.stack);
} finally {
  // ---- 8. console --------------------------------------------------------------------------
  // [css404] provokes its 404 on purpose
  const bad = consoleLog.filter((l) => !l.startsWith('[css404]') && /CSP|Refused|Error|error|pageerror|requestfailed/.test(l));
  check('8 console clean (CSP|Refused|Error)', bad.length === 0, bad.join(' | ').slice(0, 800));
  await browser.close();
  const fails = results.filter(([ok]) => !ok).length;
  console.log(`\n${results.length - fails}/${results.length} checks passed · output in ${OUT}`);
  fs.writeFileSync(path.join(OUT, 'verify-results.json'), JSON.stringify({ results, consoleLog }, null, 1));
  process.exit(fails ? 1 : 0);
}
