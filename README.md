# pinnwandii

A group greeting pinboard with no backend. Around fifty people leave a
message, a sticker and a photo for one person; the result is a single HTML
page that can be sent as a file, printed as a PDF or hosted anywhere.

Everything runs in the browser. There is no build step, no framework, no
server and no account: all state lives in the URL fragment or in the
organizer's browser storage.

## How it works

Three roles, one static page:

1. **Organizer** creates a pinboard (title, palette, hue) and gets an
   *invitation link* (`#i=`). It is short and never changes.
2. **Guests** open the invitation, write a greeting, pick a sticker, add a
   photo or an https image link, and *send back a contribution link* (`#c=`)
   over the same channel they were invited on (messenger, mail) or as a
   small text file. A photo becomes a *sketch* in the browser: about 140
   translucent triangles fitted to it, shown as SVG, roughly 1 KB. That keeps
   the whole message under 1 900 bytes, so it arrives as one message with an
   intact, tappable link even in Signal, which turns longer text into an
   attachment and cuts the link.
3. **Organizer** collects the replies on the merge page: paste links, paste a
   whole chat export, read the clipboard or drop the files. Duplicates,
   foreign pinboards and truncated links are counted, not merged. Then
   *Fertige Seite* builds the finished pinboard: one HTML file without
   JavaScript, photos embedded.

The organizer is the database. Nothing is ever written to a server, and the
invitation link never reveals who has already replied.

## Links and limits

| Link | Typical size | Fits in |
|---|---|---|
| Invitation `#i=` | ~120 chars | QR code, any messenger, mail |
| Contribution, text only | ~250 chars | anywhere |
| Contribution with photo sketch | whole message ≤ 1 900 bytes | one message in any messenger, Signal included |
| Admin link `#b=` (whole board) | 3–4 KB for 50 texts, ~1 KB more per photo, offered up to 32 000 chars | second device, backup |
| Finished page | file | download, share, print |

Tokens are `2.<base64url>` of `u32 len | zlib(JSON) | sketch bytes…`. The
zlib checksum turns a copy error into a clear message instead of a garbled
card. The longer the greeting, the fewer triangles the sketch keeps (the
last ones carry the finest detail). Version 1 tokens, whose photos were
JPEGs of up to 24 KB, are still read. Hard limits (`codec.js`,
`sketch.js`): title 80, name 60, text 1000, sticker 8 code points, sketch
200 triangles, JPEG photo 28 KB, 500 contributions, token 200 000 chars.

## Scale path

- A few dozen replies: collect over one chat, paste the exported chat once.
- Second device or in-app browser without storage: use the *Admin-Link* or
  the JSON backup from the settings dialog.
- Publish the finished board under a short link: commit the built file as
  `boards/<name>.html` in this repository; GitHub Pages serves it.

## Repository layout

| File | Purpose |
|---|---|
| `index.html` | Shell with all views, dialogs, CSP meta |
| `style.css` | Themes (`p` pastel, `b` bold, `d` dark), wall, cards, print |
| `codec.js` | Token codec, schema validation, merge helpers; pure ESM |
| `sketch.js` | Photo → triangle sketch, sketch format, SVG rendering; pure ESM |
| `app.js` | Router, views, storage, photo pipeline, static page builder |
| `test.mjs` | `node --test` suite for codec and sketches |
| `scripts/verify-browser.mjs` | End-to-end check in headless Chromium |
| `.github/workflows/pages.yml` | Deploys the repository root to GitHub Pages |

## Development

```sh
python3 -m http.server 8765   # ES modules need http://, not file://
node --test test.mjs          # Node ≥ 21.2
```

No dependencies, no build. The browser check needs `puppeteer-core` and a
Chromium outside the repository:

```sh
npm i --prefix ~/.cache/pinnwandii-verify puppeteer-core
PUPPETEER_DIR=~/.cache/pinnwandii-verify node scripts/verify-browser.mjs
ORIGIN=https://bmmmm.github.io/pinnwandii PUPPETEER_DIR=… node scripts/verify-browser.mjs
```

## License

GPL-3.0-or-later. See `LICENSE`.
