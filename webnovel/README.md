# Web Novels for CrossPoint

Search Royal Road, Scribble Hub or AO3 (Archive of Our Own), download a web novel or work as an EPUB, and later add only the new chapters to that same EPUB.

## Install

1. Copy this `webnovel` folder to `/plugins/` on the reader's SD card, so you have `/plugins/webnovel/plugin.js`.
2. On the reader, enable **Settings → Connectivity → Plugins** (beta firmware with SD plugins).
3. Start **File Transfer** on the reader (joined to your Wi‑Fi, not hotspot mode, since it needs the internet).
4. Open the reader's web page on your phone (`http://crosspoint.local` or the IP on screen) → **Settings**. The *Web Novels* card is there.

## Use

Pick **Royal Road**, **Scribble Hub** or **AO3** next to the search box (pasted links of any of them work whatever is picked). Books are saved in `/RoyalRoad/`, `/ScribbleHub/` and `/AO3/`. Browse lists are Royal Road only. Scribble Hub asks for slow, spaced-out requests, so its downloads wait about 7 seconds between pages; updates only read the newest part of its chapter list. AO3 works download in a single request (the whole work on one page); updates fetch only the new chapters. AO3 works have no covers, so the plugin draws one (title, author, fandom and a pattern unique to each book); the same happens for any book without a cover. Works limited to logged-in AO3 users can't be downloaded.

- **Search** a title, or paste a `royalroad.com/fiction/…` link. Each result shows its cover, status (Ongoing, Completed, Hiatus…), chapter count and a short blurb. Covers load straight from Royal Road on your phone.
- **Browse** Trending, Best Rated, Rising Stars, Popular This Week, Latest Updates, Popular Ongoing or Popular Completed, optionally by genre. The status filter (Ongoing / Completed) applies to search and browse results; **Show more** loads further pages.
- **Download** saves `/RoyalRoad/<Title>.epub`.
- **Check all** reads each novel's page only and shows "N new" on its card, without downloading anything.
- **Update** (or **Update all** under *My novels*) checks which chapters the EPUB already has and downloads only the new ones, then rebuilds the same EPUB. Novels found up to date by a check in the last 10 minutes are skipped.
- **Update link**: bookmark the link it shows (or add it to your home screen). Opening it while File Transfer is on starts Update all by itself; there's a Check all link too.
- Updates keep your reading position and highlights: the plugin saves them before replacing the book and puts them back afterwards, matched to the same chapters (bookmarks are kept by the reader itself).
- **Re-download all** fetches every chapter again (use it if the author edited old chapters).
- **Chapter range** (under the search box): fill *from* and/or *to* before tapping Download or Update. The range is remembered for that novel. Leave *to* empty to start at a chapter and keep getting new ones on later updates; type *from* 1 with *to* empty to go back to the whole novel.
- **Include chapter images**: on by default. Images are shrunk to grayscale JPEGs (max 480×800) for the X4. Turn it off for smaller files.
- Genres appear on the title page, in the EPUB's metadata, and on the result cards.

Keep the web page open and the reader awake while it works. Large novels take a while: the reader downloads each chapter itself, about one every 2–4 seconds. Every 50 new chapters a partial EPUB is saved, so if the page closes, the next **Update** carries on from there.

## How it works

- The reader downloads each Royal Road page to `/RoyalRoad/_tmp/` (no browser CORS issues), and this page reads it back. Finished books are sent back over the same WebSocket upload the File Manager uses, with retries.
- Your phone strips ads, scripts and Royal Road's hidden anti-piracy lines, shrinks the cover and chapter images, then builds the EPUB (cover, title page with genres and full description, table of contents) and uploads it.
- The EPUB stores its own chapter list in `META-INF/royalroad.json`; `/RoyalRoad/library.json` remembers which novels you follow.

## Limits

- If Royal Road shows a bot check to the reader, downloads fail with a message saying so.
- Author's notes are left out. An image that fails to download is skipped and the chapter is kept.
- For personal reading only; please respect the authors (Royal Road shows them ads and Patreon links you won't see here).
