// SPDX-License-Identifier: GPL-3.0-or-later
// The photo paths in Firefox and WebKit, which verify-browser.mjs (Chromium)
// cannot see: Firefox aliases a one-step canvas downscale, WebKit's JPEG
// encoder writes bigger files, so only there the smaller card sides are
// taken. Guest photo (write view) and card photo (dialog) per engine.
//
//   npm i --prefix <dir> playwright                 # once, outside the repo
//   PLAYWRIGHT_BROWSERS_PATH=<dir>/browsers npx --prefix <dir> playwright install firefox webkit
//   PLAYWRIGHT_DIR=<dir> PLAYWRIGHT_BROWSERS_PATH=<dir>/browsers node scripts/verify-engines.mjs
//
// ENGINES=firefox,webkit (default) picks the engines; the repository is served
// from disk through request interception (no local port needed).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { LIMITS, encodeInvite, newId } from '../codec.js';

const require = createRequire(path.join(process.env.PLAYWRIGHT_DIR ?? process.cwd(), 'x.js'));
const playwright = require('playwright');
const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ORIGIN = 'http://localhost:8765';
const ENGINES = (process.env.ENGINES ?? 'firefox,webkit').split(',');
const BUDGET = 1900; // MESSAGE_BUDGET in app.js
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

const results = [];
const check = (name, ok, detail = '') => {
  results.push([ok, name, detail]);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
};
const utf8 = (s) => Buffer.byteLength(s, 'utf8');
const isPhoto = (img) => img.startsWith('data:image/jpeg;base64,');
const photoBytes = (img) => Buffer.from(img.slice(img.indexOf(',') + 1), 'base64').length;
const setValue = (page, sel, value) => page.evaluate(([sel, value]) => {
  const el = document.querySelector(sel);
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}, [sel, value]);

// A JPEG with an EXIF APP1 segment that says Orientation = o (6: rotate 90° clockwise to display).
function withOrientation(jpg, o) {
  const tiff = Buffer.alloc(26);
  tiff.write('II', 0, 'ascii'); tiff.writeUInt16LE(42, 2); tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(1, 8);
  tiff.writeUInt16LE(0x0112, 10); tiff.writeUInt16LE(3, 12); tiff.writeUInt32LE(1, 14); tiff.writeUInt16LE(o, 18);
  tiff.writeUInt32LE(0, 22);
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'ascii'), tiff]);
  const app1 = Buffer.from([0xff, 0xe1, 0, 0]);
  app1.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([jpg.subarray(0, 2), app1, payload, jpg.subarray(2)]);
}

// Test images drawn in the page: a 12 MP photo-like scene with grain (8× the card side: the halving matters) and pixel noise.
async function makeImages(page, dir) {
  const [scene, noise] = await page.evaluate(() => {
    const draw = (w, h, fn, type) => {
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      fn(c.getContext('2d'));
      return c.toDataURL(type, 0.92);
    };
    return [
      draw(4000, 3000, (g) => {
        const sky = g.createLinearGradient(0, 0, 0, 1800);
        sky.addColorStop(0, '#2a62b8'); sky.addColorStop(1, '#d8ecff');
        g.fillStyle = sky; g.fillRect(0, 0, 4000, 3000);
        g.fillStyle = '#3b7d2f'; g.fillRect(0, 1800, 4000, 1200);
        g.fillStyle = '#ffcf3a'; g.beginPath(); g.arc(3200, 600, 360, 0, 7); g.fill();
        g.fillStyle = '#b02f2a'; g.fillRect(800, 1050, 1200, 900);
        g.fillStyle = '#4a2416'; g.beginPath(); g.moveTo(680, 1080); g.lineTo(1400, 450); g.lineTo(2120, 1080); g.fill();
        const id = g.getImageData(0, 0, 2000, 2000); // grain, so a one-step downscale has something to alias
        let s = 11;
        for (let i = 0; i < id.data.length; i += 4) { s = (s * 1103515245 + 12345) & 0x7fffffff; const n = (s >> 20) % 24 - 12; id.data[i] += n; id.data[i + 1] += n; id.data[i + 2] += n; }
        g.putImageData(id, 0, 0);
      }, 'image/jpeg'),
      draw(1200, 900, (g) => {
        const id = g.createImageData(1200, 900);
        let s = 7;
        for (let i = 0; i < id.data.length; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; id.data[i] = i % 4 === 3 ? 255 : s >> 23; }
        g.putImageData(id, 0, 0);
      }, 'image/png'),
    ];
  });
  const save = (buf, name) => { const f = path.join(dir, name); fs.writeFileSync(f, buf); return f; };
  const sceneBuf = Buffer.from(scene.slice(scene.indexOf(',') + 1), 'base64');
  return {
    scene: save(sceneBuf, 'scene.jpg'),
    rotated: save(withOrientation(sceneBuf, 6), 'scene-rot6.jpg'),
    noise: save(Buffer.from(noise.slice(noise.indexOf(',') + 1), 'base64'), 'noise.png'),
  };
}

// SSIM (jpeg.js) of a photo data URI against the source file, box-filtered to the photo's size: an exact reference, no canvas resampling.
const likeness = (page, src, file) => page.evaluate(async ([src, b64]) => {
  const { ssim } = await import(new URL('jpeg.js', document.baseURI).href);
  const load = async (u) => { const i = new Image(); i.src = u; await i.decode(); return i; };
  const img = await load(src);
  const w = img.naturalWidth, h = img.naturalHeight;
  const px = (i, cw, ch) => { const c = document.createElement('canvas'); c.width = cw; c.height = ch; const g = c.getContext('2d'); g.drawImage(i, 0, 0, cw, ch); return g.getImageData(0, 0, cw, ch).data; };
  const bmp = await createImageBitmap(new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))]), { imageOrientation: 'from-image' });
  const W = bmp.width, H = bmp.height;
  const acc = new Float64Array(w * h * 3), cnt = new Float64Array(w * h);
  const T = 1000;
  for (let ty = 0; ty < H; ty += T) for (let tx = 0; tx < W; tx += T) {
    const tw = Math.min(T, W - tx), th = Math.min(T, H - ty);
    const c = document.createElement('canvas'); c.width = tw; c.height = th;
    const g = c.getContext('2d'); g.drawImage(bmp, tx, ty, tw, th, 0, 0, tw, th);
    const d = g.getImageData(0, 0, tw, th).data;
    for (let y = 0; y < th; y++) {
      const oy = Math.min(h - 1, Math.floor(((ty + y) * h) / H));
      for (let x = 0; x < tw; x++) {
        const ox = Math.min(w - 1, Math.floor(((tx + x) * w) / W));
        const i = (y * tw + x) * 4, o = oy * w + ox;
        acc[o * 3] += d[i]; acc[o * 3 + 1] += d[i + 1]; acc[o * 3 + 2] += d[i + 2]; cnt[o]++;
      }
    }
  }
  bmp.close();
  const ref = new Uint8ClampedArray(w * h * 4);
  for (let o = 0; o < w * h; o++) { ref[o * 4] = acc[o * 3] / cnt[o]; ref[o * 4 + 1] = acc[o * 3 + 1] / cnt[o]; ref[o * 4 + 2] = acc[o * 3 + 2] / cnt[o]; ref[o * 4 + 3] = 255; }
  return { w, h, ssim: ssim(px(img, w, h), ref, w, h) };
}, [src, fs.readFileSync(file).toString('base64')]);

const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'pinnwandii-engines-'));
for (const engine of ENGINES) {
  const browser = await playwright[engine].launch({ headless: true });
  const label = (name) => `${engine}: ${name}`;
  try {
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 }, locale: 'de-DE' });
    await ctx.route('**/*', (route) => {
      const u = new URL(route.request().url());
      if (u.origin !== ORIGIN) return route.fulfill({ status: 404, body: 'not found' });
      const file = path.join(REPO, u.pathname === '/' ? 'index.html' : decodeURIComponent(u.pathname));
      if (!file.startsWith(REPO) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return route.fulfill({ status: 404, body: 'not found' });
      route.fulfill({ status: 200, contentType: TYPES[path.extname(file)] ?? 'application/octet-stream', body: fs.readFileSync(file) });
    });
    const errors = [];
    const org = await ctx.newPage();
    org.on('pageerror', (e) => errors.push(e.message));
    await org.goto(`${ORIGIN}/`);
    const images = await makeImages(org, dir);
    await setValue(org, '#new-form input[name=title]', 'Engines');
    await org.click('#new-form button.primary');
    await org.waitForFunction(() => /^#o=/.test(location.hash));
    const boardId = await org.evaluate(() => location.hash.slice(3));

    // ---- guest: a photo fits the message and looks like the original -------
    const guest = await ctx.newPage();
    guest.on('pageerror', (e) => errors.push(e.message));
    await guest.goto(`${ORIGIN}/#i=${await encodeInvite({ id: boardId, title: 'Engines', preset: 'p', hue: 200 })}`);
    await setValue(guest, '#write-form input[name=name]', 'Anna');
    await setValue(guest, '#write-form textarea[name=text]', 'Alles Gute!');
    const t0 = Date.now();
    await guest.setInputFiles('#write-form input[name=photo]', images.scene);
    await guest.waitForFunction(() => document.querySelector('#write-note').textContent.startsWith('Foto übernommen'), null, { timeout: 60000 });
    const guestMs = Date.now() - t0;
    await guest.waitForFunction(() => document.querySelector('#write-link').value.length > 100, null, { timeout: 20000 });
    const sent = await guest.evaluate(() => ({ link: document.querySelector('#write-link').value, img: document.querySelector('#preview .card img')?.src ?? '' }));
    const msg = `Glückwunsch von Anna für „Engines“: ${sent.link}`; // messageFor in app.js
    const guestLook = isPhoto(sent.img) ? await likeness(guest, sent.img, images.scene) : {};
    check(label('guest photo: in the link, message within the budget'), isPhoto(sent.img) && utf8(msg) <= BUDGET, `${guestLook.w}×${guestLook.h} px, ${isPhoto(sent.img) ? photoBytes(sent.img) : '-'} B, message ${utf8(msg)} B, ${guestMs} ms`);
    check(label('guest photo: looks like the original (SSIM ≥ 0.8 against a box-filtered source)'), guestLook.ssim >= 0.8, `ssim ${guestLook.ssim?.toFixed(3)}`);

    // ---- card dialog: 480 px, sharp, within the limit, oriented ------------
    const cardPhotoOf = async (file) => {
      const before = await org.$$eval('#wall .card', (c) => c.length);
      await org.click('#toolbar [data-act=write]');
      await org.waitForFunction(() => document.querySelector('#dlg-card').open);
      await setValue(org, '#card-form input[name=name]', 'Orga');
      await setValue(org, '#card-form textarea[name=text]', path.basename(file));
      const t = Date.now();
      await org.setInputFiles('#card-form input[name=photo]', file);
      await org.waitForFunction(() => !document.querySelector('#card-note').textContent.startsWith('Foto wird'), null, { timeout: 60000 });
      const ms = Date.now() - t;
      const note = await org.$eval('#card-note', (e) => e.textContent);
      await org.$eval('#card-save', (b) => b.click());
      await org.waitForFunction(() => !document.querySelector('#dlg-card').open || document.querySelector('#toast').textContent.length > 0, null, { timeout: 30000 }).catch(() => {});
      if (await org.evaluate(() => document.querySelector('#dlg-card').open)) await org.$eval('#dlg-card [data-close]', (b) => b.click());
      const added = (await org.$$eval('#wall .card', (c) => c.length)) === before + 1; // a refused save leaves the previous card last
      const src = added ? await org.evaluate(() => document.querySelector('#wall .card:last-child img')?.src ?? '') : '';
      return { src, note, ms };
    };
    const own = await cardPhotoOf(images.scene);
    const ownLook = isPhoto(own.src) ? await likeness(org, own.src, images.scene) : {};
    check(label('card photo: 480 px wide, within the limit'), isPhoto(own.src) && ownLook.w === 480 && photoBytes(own.src) <= LIMITS.photo, `${ownLook.w}×${ownLook.h} px, ${isPhoto(own.src) ? photoBytes(own.src) : '-'} B, ${own.ms} ms; note "${own.note}"`);
    check(label('card photo: downscaled sharply (SSIM ≥ 0.97 against a box-filtered source; one-step Firefox: ~0.91)'), ownLook.ssim >= 0.97, `ssim ${ownLook.ssim?.toFixed(3)}`);
    const rot = await cardPhotoOf(images.rotated);
    const rotLook = isPhoto(rot.src) ? await likeness(org, rot.src, images.rotated) : {};
    check(label('card photo: EXIF orientation 6 comes out portrait and upright'), isPhoto(rot.src) && rotLook.h > rotLook.w && rotLook.ssim >= 0.97, `${rotLook.w}×${rotLook.h} px, ssim ${rotLook.ssim?.toFixed(3)}`);
    const noisy = await cardPhotoOf(images.noise);
    const noisyW = isPhoto(noisy.src) ? (await likeness(org, noisy.src, images.noise)).w : 0;
    check(label('card photo: pixel noise still lands within the limit (a lower quality or a smaller side)'), isPhoto(noisy.src) && noisyW >= 240 && noisyW <= 480 && photoBytes(noisy.src) <= LIMITS.photo, `${noisyW} px wide, ${isPhoto(noisy.src) ? photoBytes(noisy.src) : '-'} B; note "${noisy.note}"`);
    check(label('no page errors'), errors.length === 0, errors.join(' | ').slice(0, 200));
  } catch (e) {
    check(label('script completed without exception'), false, String(e).split('\n')[0]);
  } finally {
    await browser.close();
  }
}
const failed = results.filter(([ok]) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
