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
   small text file. A photo is re-encoded in the browser as a small JPEG
   (which also drops its metadata such as the location): the app tries
   several sizes and qualities, scores each against the photo (SSIM) and
   sends the best one for which the whole message stays under 1 900 bytes.
   So it arrives as one message with an intact, tappable link even in
   Signal, which turns longer text into an attachment and cuts the link.
   The app's own encoder always uses the same tables, so the ~590-byte JPEG
   header is left out of the link and put back on arrival; at ~1 KB that
   doubles the picture data. The longer the greeting, the smaller the
   photo; a greeting that leaves no room at all goes without it.
   Instead of a photo a greeting can carry one link: a YouTube video, a
   GIF from Tenor or Giphy, or any https image. Pasted links are reduced to
   one canonical address (`media.js`: tracking parameters dropped, the
   start time kept), which travels like an image link, so the link format
   is unchanged.
3. **Organizer** collects the replies on the merge page: paste links, paste a
   whole chat export, read the clipboard or drop the files. Duplicates,
   foreign pinboards and truncated links are counted, not merged. Every
   card has an edit button (✎): correct name or text, change the sticker,
   add or replace the photo, set a video or GIF link, remove the picture,
   move the card, delete it. *Karte schreiben* adds a card of the
   organizer's own. Then *Fertige Seite* builds
   the finished pinboard: one HTML file without JavaScript, photos
   embedded, videos as thumbnail links. A board with YouTube videos or
   Tenor GIFs also gets a *videos file*: the same page with one small
   script (allowed by its hash in the page's CSP) that plays them in place
   once the page is online. From a local file YouTube refuses to play (it
   needs the page's address as Referer), so there the videos file shows
   *Online ansehen*: a `#v=` link that opens the same board in the app,
   where the videos play.

The organizer is the database. Nothing is ever written to a server, and the
invitation link never reveals who has already replied. Each card remembers
which contribution it came from (a short hash), and the board remembers
deleted ones: pasting the same chat again, or merging an older backup or
admin link, neither brings a deleted card back nor adds an edited one
twice. A card the organizer writes comes from no link and gets a random
origin, so the same card written again after a deletion is new. Deletions made on another device travel with its admin link or
backup, after the app asks (with the names) whether to delete here too;
where both devices edited the same card, the device you merge into keeps
its version. A board nobody curated is stored exactly as before version 3,
so a tab still running an older copy of the app can read it.

Videos and GIFs on the wall: a YouTube card shows the video's thumbnail
(loaded from YouTube at once) and plays in place on a click, through
`youtube-nocookie.com`; a Tenor GIF waits for a click, because Tenor's
player loads Google Analytics and ad trackers; a Giphy GIF or a direct GIF
address is a plain image and shows at once. A video whose owner disabled
embedding shows YouTube's notice with a link to watch it there.

## Links and limits

| Link | Typical size | Fits in |
|---|---|---|
| Invitation `#i=` | ~120 chars | QR code, any messenger, mail |
| Contribution, text only | ~250 chars | anywhere |
| Contribution with photo | whole message ≤ 1 900 bytes | one message in any messenger, Signal included |
| Admin link `#b=` (whole board) | 3–4 KB for 50 texts, ~1 KB more per photo, offered up to 32 000 chars | second device, backup |
| Finished page | file | download, share, print |
| Videos file | file, plus an *Online ansehen* link `#v=`: the whole board up to 32 000 chars, else only the cards with players, else none (each card then links to YouTube or Tenor) | download, share; the link opens in the browser |

Tokens are `3.<base64url>` of `u32 len | zlib(JSON) | photo bytes…`. The
zlib checksum turns a copy error into a clear message instead of a garbled
card. Older tokens are still read: version 1 carried JPEGs of up to 24 KB,
version 2 photo sketches (translucent triangles, `sketch.js`); boards from
before version 3 get their card origins on loading. Hard limits
(`codec.js`): title 80, name 60, text 1000, sticker 8 code points, photo
28 KB, 500 contributions, 2000 remembered deletions, token 200 000 chars.

## Scale path

- A few dozen replies: collect over one chat, paste the exported chat once.
- Second device or in-app browser without storage: use the *Admin-Link* or
  the JSON backup from the settings dialog.
- Publish the finished board under a short link: commit the built file as
  `boards/<name>.html` in this repository; GitHub Pages serves it. Served
  like that, the videos file plays its videos in place.

## Repository layout

| File | Purpose |
|---|---|
| `index.html` | Shell with all views, dialogs, CSP meta |
| `style.css` | Themes (`p` pastel, `b` bold, `d` dark), wall, cards, print |
| `codec.js` | Token codec, schema validation, merge helpers; pure ESM |
| `jpeg.js` | JPEG encoder with fixed tables, header stripping, SSIM; pure ESM |
| `sketch.js` | Reads the photo sketches of version 2 links; pure ESM |
| `media.js` | YouTube, Tenor and Giphy links: canonical form, thumbnails, players; pure ESM |
| `app.js` | Router, views, storage, photo pipeline, static page builder |
| `test.mjs` | `node --test` suite for codec and photos |
| `scripts/verify-browser.mjs` | End-to-end check in headless Chromium |
| `.github/workflows/pages.yml` | Deploys the repository root to GitHub Pages |

## Development

```sh
python3 -m http.server 8765   # ES modules need http://, not file://
node --test test.mjs          # Node ≥ 21.2
```

No dependencies, no build. A videos file built from a local copy links its
*Online ansehen* to that copy (e.g. `localhost`); build it from the hosted
app to share it. The browser check needs `puppeteer-core` and a Chromium
outside the repository:

```sh
npm i --prefix ~/.cache/pinnwandii-verify puppeteer-core
PUPPETEER_DIR=~/.cache/pinnwandii-verify node scripts/verify-browser.mjs
ORIGIN=https://bmmmm.github.io/pinnwandii PUPPETEER_DIR=… node scripts/verify-browser.mjs
```

## License

GPL-3.0-or-later. See `LICENSE`.
