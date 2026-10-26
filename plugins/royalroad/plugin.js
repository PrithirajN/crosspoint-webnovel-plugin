/*
 * Web novels (Royal Road, Scribble Hub) \u2192 EPUB plugin for CrossPoint Reader (SD-card plugin, browser side).
 *
 * How it works
 *  - The X4 downloads each page to the SD card (api.fetchToSd; no CORS,
 *    no 32 KB relay cap), then this page reads it back over /download and parses it.
 *  - All the heavy work (HTML cleanup, zipping) runs here in the phone/computer browser.
 *  - The EPUB itself carries the list of chapters it contains (META-INF/royalroad.json),
 *    so an update only downloads chapters that are missing and rebuilds the book.
 *
 * Install: copy the "royalroad" folder to /plugins/ on the SD card.
 */
(function () {
  "use strict";

  const RR = "https://www.royalroad.com";
  const SH = "https://www.scribblehub.com";
  const ROOT = "/RoyalRoad";            // library.json and Royal Road books
  const SH_ROOT = "/ScribbleHub";       // Scribble Hub books
  const SH_DELAY_MS = 7500;             // Scribble Hub asks for slow, spaced-out requests
  const AO = "https://archiveofourown.org";
  const AO_ROOT = "/AO3";               // Archive of Our Own works
  const AO_DELAY_MS = 3000;             // AO3 rate-limits busy clients
  const TMP = ROOT + "/_tmp";           // scratch files, deleted after each job
  const LIB_FILE = "library.json";
  const DELAY_MS = 1200;                // pause between chapter requests (be polite)
  const CHECKPOINT_EVERY = 50;          // save a partial EPUB every N new chapters
  const HEADERS = {
    "User-Agent":
      "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
  };
  const STATUSES = ["ONGOING", "COMPLETED", "HIATUS", "STUB", "DROPPED", "INACTIVE"];

  // ---------------------------------------------------------------- small helpers
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const txt = (el) => (el ? el.textContent.replace(/\s+/g, " ").trim() : "");
  const num = (m) => (m ? parseInt(m[1].replace(/,/g, ""), 10) : null);
  const abs = (href) => (!href ? "" : href.startsWith("http") ? href : RR + (href.startsWith("/") ? "" : "/") + href);
  const BAD_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;
  const esc = (s) =>
    String(s == null ? "" : s)
      .replace(BAD_XML, "")
      .replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const safeName = (s) =>
    String(s || "Untitled").replace(/[\\/:*?"<>|\u0000-\u001F]/g, "").replace(/\s+/g, " ").trim().slice(0, 80) ||
    "Untitled";
  const sourceOf = (url) => (/scribblehub\.com/i.test(url || "") ? "sh" : /archiveofourown\.org|ao3\.org/i.test(url || "") ? "ao" : "rr");
  const SOURCES = { rr: { name: "Royal Road", dir: ROOT, delay: DELAY_MS }, sh: { name: "Scribble Hub", dir: SH_ROOT, delay: SH_DELAY_MS },
    ao: { name: "AO3", dir: AO_ROOT, delay: AO_DELAY_MS } };
  const fictionId = (url) => {
    if (sourceOf(url) === "sh") { const m = (url || "").match(/\/series\/(\d+)/); return m ? "sh-" + m[1] : null; }
    if (sourceOf(url) === "ao") { const m = (url || "").match(/\/works\/(\d+)/); return m ? "ao-" + m[1] : null; }
    return ((url || "").match(/\/fiction\/(\d+)/) || [])[1] || null;
  };
  const absFor = (base, href) => (!href ? "" : /^https?:/i.test(href) ? href : href.startsWith("//") ? "https:" + href : base + (href.startsWith("/") ? "" : "/") + href);
  // Scribble Hub's Cloudflare rules block list pages fetched without a Referer
  const shHeaders = (referer) => ({ Referer: referer || SH + "/", "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Site": "same-origin" });
  const pickStatus = (labels) => labels.find((l) => STATUSES.includes(l)) || "UNKNOWN";
  const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

  // ---------------------------------------------------------------- device file access
  async function readSd(path, as) {
    const r = await fetch("/download?path=" + encodeURIComponent(path), { cache: "no-store" });
    if (!r.ok) return null;
    return as === "blob" ? r.blob() : r.text();
  }
  async function postForm(url, fields) {
    const r = await fetch(url, { method: "POST", body: new URLSearchParams(fields) });
    return { ok: r.ok, status: r.status, text: await r.text().catch(() => "") };
  }
  // The reader's /upload and /rename refuse to replace an existing file, so saving is:
  // upload as "<name>.new" -> delete the old file -> rename "<name>.new" to "<name>".
  // Send one file the way the reader's own File Manager does: WebSocket on port 81 in 4 KB
  // chunks with back-pressure (START:<name>:<size>:<dir> -> READY -> data -> DONE / ERROR:...).
  // The reader deletes a half-received file itself if the connection drops.
  const WS_CHUNK = 4096;
  function uploadWs(dir, name, blob) {
    return new Promise((resolve, reject) => {
      let ws;
      try { ws = new WebSocket("ws://" + location.hostname + ":" + ((parseInt(location.port, 10) || 80) + 1) + "/"); }
      catch (e) { const err = new Error("WebSocket unavailable"); err.noWs = true; return reject(err); }
      ws.binaryType = "arraybuffer";
      let opened = false, done = false;
      const fail = (msg) => { if (done) return; done = true; try { ws.close(); } catch (e) { /* ignore */ } reject(new Error(msg)); };
      const timer = setTimeout(() => { if (!opened) { const e = new Error("WebSocket didn't connect"); e.noWs = true; done = true; try { ws.close(); } catch (x) { /* ignore */ } reject(e); } }, 8000);
      ws.onopen = () => { opened = true; clearTimeout(timer); ws.send("START:" + name + ":" + blob.size + ":" + dir); };
      ws.onmessage = async (ev) => {
        const msg = String(ev.data);
        if (msg === "READY") {
          try {
            for (let off = 0; off < blob.size; off += WS_CHUNK) {
              while (ws.bufferedAmount > WS_CHUNK * 2 && ws.readyState === WebSocket.OPEN) await sleep(5);
              if (ws.readyState !== WebSocket.OPEN) return fail("connection closed while sending");
              ws.send(await blob.slice(off, off + WS_CHUNK).arrayBuffer());
            }
          } catch (e) { fail(e.message); }
        } else if (msg === "DONE") {
          done = true; try { ws.close(); } catch (e) { /* ignore */ } resolve();
        } else if (msg.startsWith("ERROR:")) {
          fail(msg.slice(6));
        }
      };
      ws.onerror = () => { if (!opened) { clearTimeout(timer); const e = new Error("WebSocket didn't connect"); e.noWs = true; if (!done) { done = true; reject(e); } } else fail("connection error while sending"); };
      ws.onclose = () => { clearTimeout(timer); if (!done) { if (!opened) { const e = new Error("WebSocket didn't connect"); e.noWs = true; done = true; reject(e); } else fail("connection closed before the reader confirmed"); } };
    });
  }
  async function uploadHttp(dir, name, blob) {
    const fd = new FormData();
    fd.append("file", blob, name);
    let r;
    try { r = await fetch("/upload?path=" + encodeURIComponent(dir), { method: "POST", body: fd }); }
    catch (e) { throw new Error("connection lost while sending (" + e.message + ")"); }
    if (!r.ok) {
      const why = await r.text().catch(() => "");
      throw new Error("HTTP " + r.status + (why ? ": " + why : ""));
    }
  }
  let wsWorks = true;
  async function uploadOnce(dir, name, blob) {
    if (wsWorks) {
      try { return await uploadWs(dir, name, blob); }
      catch (e) { if (!e.noWs) throw e; wsWorks = false; } // no WebSocket here: use HTTP from now on
    }
    return uploadHttp(dir, name, blob);
  }

  async function uploadSd(dir, name, blob) {
    const base = dir.replace(/\/+$/, "") + "/";
    const tmpName = name + ".new";
    for (let attempt = 1; ; attempt++) {
      await postForm("/delete", { path: base + tmpName }); // leftover from an interrupted save
      try { await uploadOnce(dir, tmpName, blob); break; }
      catch (e) {
        if (attempt >= 3) throw new Error("Saving " + name + " failed: " + e.message);
        await sleep(3000 * attempt); // give the reader a moment (e.g. "Upload already in progress")
      }
    }
    await postForm("/delete", { path: base + name }); // fine if it doesn't exist yet
    const mv = await postForm("/rename", { path: base + tmpName, name });
    if (!mv.ok) {
      throw new Error("Saved as " + tmpName + " but couldn't rename it (HTTP " + mv.status +
        (mv.text ? ": " + mv.text : "") + "). Rename it on the reader to keep it.");
    }
  }
  async function deleteSd(paths) {
    try {
      await fetch("/delete", { method: "POST", body: new URLSearchParams({ paths: JSON.stringify(paths) }) });
    } catch (e) { /* ignore */ }
  }
  async function ensureRoot(dir) {
    for (const d of new Set([ROOT, dir || ROOT])) {
      try { await fetch("/mkdir", { method: "POST", body: new URLSearchParams({ name: d.slice(1), path: "/" }) }); }
      catch (e) { /* already exists */ }
    }
  }

  let JSZipLib = null;
  function loadJSZip() {
    if (JSZipLib) return Promise.resolve(JSZipLib);
    if (window.JSZip) return Promise.resolve((JSZipLib = window.JSZip));
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "/js/jszip.min.js";
      s.onload = () => resolve((JSZipLib = window.JSZip));
      s.onerror = () => reject(new Error("Could not load JSZip from the device"));
      document.head.appendChild(s);
    });
  }

  // ---------------------------------------------------------------- plugin
  CrossPoint.registerPlugin(function (container, api) {
    // ---- Royal Road access, via the device
    async function fetchToTmp(url, name, extra) {
      const dest = TMP + "/" + name;
      await deleteSd([dest]); // never parse a stale copy if this download fails
      const r = await api.fetchToSd(url, dest, Object.assign({}, HEADERS, extra || {}));
      if (r && (r.error || (r.status && r.status !== 200) || r.complete === false)) {
        throw new Error("Download failed: " + (r.error || "HTTP " + r.status) + " \u2014 " + url);
      }
      return dest;
    }
    async function fetchDoc(url, extra) {
      if (!extra && sourceOf(url) === "sh") extra = shHeaders();
      const html = await readSd(await fetchToTmp(url, "page.html", extra));
      if (!html) throw new Error("Could not read the downloaded page \u2014 " + url);
      const doc = new DOMParser().parseFromString(html, "text/html");
      // Normal Royal Road pages also load Cloudflare's challenge-platform script, so only a
      // real interstitial counts: its title, or its challenge form with none of the page content.
      const title = txt(doc.querySelector("title"));
      const hasContent = doc.querySelector(".fiction-list-item, .fic-title, .fic-header, .chapter-content, div.chapter-inner, .fiction-title, #chapters, " +
        ".fic_title, #chp_raw, a.toc_a, .search_main_box, .wi_fic_desc, div.chapter-title, " +
        "#chapters, #workskin, h2.title.heading, ol.chapter.index, li.work.blurb, ol.work.index") ||
        /window\.chapters\s*=/.test(html);
      if (/^(just a moment|attention required)/i.test(title) || (!hasContent && /_cf_chl_opt|cf-chl-widget/.test(html))) {
        await saveDebug(html);
        throw new Error(SOURCES[sourceOf(url)].name + " showed the reader a Cloudflare bot check (\"" + title + "\"). Saved it as " +
          ROOT + "/debug-last-page.html.");
      }
      if (!hasContent) await saveDebug(html);
      return doc;
    }
    // Keep a copy of a page we couldn't use, so it can be opened from the File Manager.
    async function saveDebug(html) {
      try { await uploadSd(ROOT, "debug-last-page.html", new Blob([html], { type: "text/html" })); } catch (e) { /* ignore */ }
    }
    // ---- reading position
    // The reader keeps your place in /.crosspoint/epub_<std::hash(book path)>/progress.bin and
    // deletes that folder whenever the book file is replaced. We read it before an update and
    // write it back afterwards. std::hash<std::string> on the 32-bit ESP32 is libstdc++'s
    // MurmurHash2 with seed 0xc70f6907; this port matches it byte for byte.
    function stdHash32(str) {
      const b = new TextEncoder().encode(str);
      const m = 0x5bd1e995;
      let len = b.length, h = (0xc70f6907 ^ len) >>> 0, i = 0;
      while (len >= 4) {
        let k = (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
        k = Math.imul(k, m) >>> 0; k = (k ^ (k >>> 24)) >>> 0; k = Math.imul(k, m) >>> 0;
        h = Math.imul(h, m) >>> 0; h = (h ^ k) >>> 0;
        i += 4; len -= 4;
      }
      switch (len) {
        case 3: h = (h ^ (b[i + 2] << 16)) >>> 0; // fallthrough
        case 2: h = (h ^ (b[i + 1] << 8)) >>> 0;  // fallthrough
        case 1: h = (h ^ b[i]) >>> 0; h = Math.imul(h, m) >>> 0;
      }
      h = (h ^ (h >>> 13)) >>> 0; h = Math.imul(h, m) >>> 0; h = (h ^ (h >>> 15)) >>> 0;
      return h;
    }
    const progressFile = (bookPath) => "/.crosspoint/epub_" + stdHash32(bookPath) + "/progress.bin";
    async function readProgress(bookPath) {
      const blob = await readSd(progressFile(bookPath), "blob");
      if (!blob) return null;
      const bytes = new Uint8Array(await blob.arrayBuffer());
      return [4, 6, 10].includes(bytes.length) ? bytes : null;
    }
    async function writeProgress(bookPath, bytes) { await writeBytes(progressFile(bookPath), bytes); }
    // Highlights: /.crosspoint/clippings/epub_<same hash>.bin (+ a ".deleted" sync journal).
    // The firmware deletes them with the old book file, so they are carried over too.
    const clippingsFile = (bookPath) => "/.crosspoint/clippings/epub_" + stdHash32(bookPath) + ".bin";
    async function readBytes(path) {
      const blob = await readSd(path, "blob");
      return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
    }
    async function writeBytes(path, bytes) {
      let bin = "";
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      const r = await api.writeFile(path, btoa(bin));
      if (r && r.error) throw new Error(r.error);
    }
    // Rewrite every highlight's chapter (spine index) with mapIdx. Layout (little-endian), from
    // the firmware's ClippingStore: u8 version, u16 count, 3 x (u32 len + bytes) header strings;
    // per record: u16 spineIndex, 7 x u16, u32 time, [v>=3] u32 layout, [v>=4] u32,u32,u64,u8,char[65],
    // char[48] chapter title, then text length (v1: u32, else u16) + text.
    function remapClippings(bytes, mapIdx) {
      const out = bytes.slice();
      const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
      let o = 0;
      const version = dv.getUint8(o); o += 1;
      if (version < 1 || version > 4) throw new Error("unknown highlights format v" + version);
      const count = dv.getUint16(o, true); o += 2;
      for (let i = 0; i < 3; i++) o += 4 + dv.getUint32(o, true);
      for (let i = 0; i < count; i++) {
        dv.setUint16(o, mapIdx(dv.getUint16(o, true)), true);
        o += 20 + (version >= 3 ? 4 : 0) + (version >= 4 ? 82 : 0) + 48;
        if (version === 1) { o += 4 + dv.getUint32(o, true); } else { o += 2 + dv.getUint16(o, true); }
        if (o > out.length) throw new Error("highlights file looks truncated");
      }
      return out;
    }

    // Everything the reader would lose when the book file is replaced
    async function readReaderState(bookPath) {
      const st = {};
      try { st.progress = await readProgress(bookPath); } catch (e) { /* none */ }
      const clip = clippingsFile(bookPath);
      try { st.clippings = (await readBytes(clip)) || (await readBytes(clip + ".bak")); } catch (e) { /* none */ }
      try { st.deleted = await readBytes(clip + ".deleted"); } catch (e) { /* none */ }
      return st;
    }
    async function restoreReaderState(bookPath, st, mapIdx, describe) {
      if (st.progress) {
        const out = st.progress.slice();
        const idx = mapIdx(out[0] | (out[1] << 8));
        out[0] = idx & 0xff; out[1] = (idx >> 8) & 0xff;
        try { await writeProgress(bookPath, out); log("Kept your reading position" + describe(idx) + "."); }
        catch (e) { log("Couldn't restore your reading position (" + e.message + ")."); }
      } else {
        log("No saved reading position found for this book.");
      }
      if (st.clippings && st.clippings.length > 3) {
        const clip = clippingsFile(bookPath);
        try {
          let bytes = st.clippings;
          try { bytes = remapClippings(st.clippings, mapIdx); }
          catch (e) { log("Highlights kept as they were (" + e.message + ")."); }
          await writeBytes(clip, bytes);
          if (st.deleted && st.deleted.length) await writeBytes(clip + ".deleted", st.deleted);
          const n = st.clippings[1] | (st.clippings[2] << 8);
          log("Kept your " + n + " highlight" + (n === 1 ? "" : "s") + ".");
        } catch (e) { log("Couldn't restore your highlights (" + e.message + ")."); }
      }
    }

    // Spine of a built book: [cover], title page, then the chapters in order
    const spineOf = (hasCover, chapterIds) => (hasCover ? ["#cover"] : []).concat(["#title"], chapterIds);

    async function fetchBlob(url, name) {
      if (url.startsWith("data:")) return (await fetch(url)).blob();
      return readSd(await fetchToTmp(url, name || "file.bin", sourceOf(url) === "sh" ? shHeaders() : null), "blob");
    }

    // Any image \u2192 small grayscale JPEG (bytes) sized for the X4 screen
    async function toJpeg(blob, maxW, maxH, quality) {
      if (!blob || !blob.size) return null;
      const bmp = await createImageBitmap(blob);
      const scale = Math.min(1, maxW / bmp.width, maxH / bmp.height);
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(bmp.width * scale));
      c.height = Math.max(1, Math.round(bmp.height * scale));
      const g = c.getContext("2d");
      g.fillStyle = "#fff";
      g.fillRect(0, 0, c.width, c.height); // transparent PNGs get a white background
      g.filter = "grayscale(1)";
      g.drawImage(bmp, 0, 0, c.width, c.height);
      const out = await new Promise((r) => c.toBlob(r, "image/jpeg", quality));
      return out ? new Uint8Array(await out.arrayBuffer()) : null;
    }
    const hash = (s) => {
      let h = 0x811c9dc5;
      for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
      return (h >>> 0).toString(16).padStart(8, "0");
    };

    // ---- parsing (selectors cover both the old and the redesigned Royal Road pages)
    const metaContent = (doc, names) => {
      for (const n of names) {
        const el = doc.querySelector('meta[property="' + n + '"], meta[name="' + n + '"]');
        const v = el && el.getAttribute("content");
        if (v) return v.trim();
      }
      return "";
    };
    function bookJsonLd(doc) {
      for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) {
        try {
          const d = JSON.parse(s.textContent.trim());
          for (const x of Array.isArray(d) ? d : [d]) if (x && x["@type"] === "Book") return x;
        } catch (e) { /* ignore malformed block */ }
      }
      return null;
    }
    const uniq = (arr) => [...new Set(arr.map((s) => s.trim()).filter(Boolean))];
    const tagsIn = (el) => uniq([...el.querySelectorAll("a.fiction-tag, a[href*='tagsAdd=']")].map(txt));

    function parseSearch(doc) {
      return [...doc.querySelectorAll(".fiction-list-item")]
        .map((el) => {
          const a = el.querySelector(".fiction-title a") || el.querySelector("h2 a");
          if (!a) return null;
          const t = txt(el);
          const desc = el.querySelector('[id^="description"]');
          const img = el.querySelector("img");
          const coverSrc = img ? (img.getAttribute("data-src") || img.getAttribute("src") || "") : "";
          return {
            id: fictionId(a.getAttribute("href")),
            title: txt(a),
            url: abs(a.getAttribute("href")),
            status: pickStatus([...el.querySelectorAll(".label")].map((l) => txt(l).toUpperCase())),
            chapters: num(t.match(/([\d,]+)\s+Chapters?/i)),
            pages: num(t.match(/([\d,]+)\s+Pages?/i)),
            genres: tagsIn(el),
            coverUrl: coverSrc && !/nocover|^data:/i.test(coverSrc) ? abs(coverSrc) : "",
            blurb: txt(desc).slice(0, 400),
          };
        })
        .filter(Boolean);
    }

    function parseChapterList(doc) {
      for (const s of doc.querySelectorAll("script")) {
        const m = s.textContent.match(/window\.chapters\s*=\s*(\[[\s\S]*?\])\s*;/);
        if (!m) continue;
        try {
          const list = JSON.parse(m[1]);
          if (list.length && list[0].order != null) list.sort((a, b) => a.order - b.order);
          return list.filter((c) => c && c.id != null).map((c) => ({
            id: String(c.id), title: String(c.title || "Chapter").trim(), url: abs(c.url || ""),
          }));
        } catch (e) { /* fall through to the table */ }
      }
      return [...doc.querySelectorAll("#chapters tbody tr, table tbody tr")]
        .map((tr) => {
          const a = tr.querySelector("a[href*='/chapter/']");
          const href = tr.getAttribute("data-url") || (a && a.getAttribute("href"));
          const id = ((href || "").match(/\/chapter\/(\d+)/) || [])[1];
          return id ? { id, title: txt(a) || "Chapter", url: abs(href) } : null;
        })
        .filter(Boolean);
    }

    function parseFiction(doc, url) {
      const ld = bookJsonLd(doc) || {};
      const header = doc.querySelector(".fic-header") || doc;

      const ogTitle = metaContent(doc, ["og:title"]).replace(/\s*\|\s*Royal Road\s*$/i, "");
      const title = txt(doc.querySelector(".fic-header h1")) || txt(doc.querySelector(".fic-title h1")) ||
        (ld.name || "").trim() || ogTitle || txt(doc.querySelector("h1")) || "Untitled";

      const ldAuthor = ld.author && (Array.isArray(ld.author) ? ld.author[0] : ld.author);
      const author = txt(header.querySelector("a[href^='/profile/']")) || metaContent(doc, ["books:author"]) ||
        ((ldAuthor && ldAuthor.name) || "").trim() || txt(doc.querySelector(".fic-title h4 a")) || "Unknown";

      // Status: labels first, then any short leaf element whose whole text is a status word
      let status = pickStatus([...doc.querySelectorAll(".fiction-info .label, .fic-header .label, span.label")]
        .map((l) => txt(l).toUpperCase()));
      if (status === "UNKNOWN") {
        const leaf = [...header.querySelectorAll("span, a, div, p")].find((e) =>
          !e.children.length && STATUSES.includes(txt(e).toUpperCase()));
        if (leaf) status = txt(leaf).toUpperCase();
      }

      const coverEl = doc.querySelector(".cover-art-container img, img.thumbnail, img[data-type='cover']");
      const coverUrl = abs(metaContent(doc, ["og:image", "twitter:image"]) || (coverEl && coverEl.getAttribute("src")) || "");

      // Full description: page element, else JSON-LD (HTML fragment), else the og: summary
      let descEl = doc.querySelector(".description .hidden-content, .fiction-info .description, div.description");
      if (!descEl && ld.description) descEl = new DOMParser().parseFromString(ld.description, "text/html").body;
      const og = metaContent(doc, ["og:description", "description"]);
      const descriptionX = descEl ? toXhtml(descEl) : og ? "<p>" + esc(og) + "</p>" : "";

      let genres = tagsIn(doc);
      if (!genres.length && Array.isArray(ld.genre)) {
        genres = uniq(ld.genre.map((g) => { const m = String(g).match(/genre=([^&]+)/); return m ? decodeURIComponent(m[1]).replace(/_/g, " ") : String(g); }));
      }

      return {
        id: fictionId(url),
        url: url.split("?")[0],
        title, author, status, coverUrl, genres, descriptionX,
        descriptionText: descEl ? ([...descEl.querySelectorAll("p")].map(txt).filter(Boolean).join(" ") || txt(descEl)) : og,
        chapters: parseChapterList(doc),
      };
    }

    // ---- Scribble Hub (selectors follow WebToEpub's ScribblehubParser, plus tolerant fallbacks)
    const shSeriesUrl = (url) => {
      const m = (url || "").match(/\/series\/(\d+)(?:\/([^/?#]+))?/);
      return m ? SH + "/series/" + m[1] + "/" + (m[2] ? m[2] + "/" : "") : url;
    };
    const SH_STATUS = /\b(ongoing|completed|hiatus|dropped)\b/i;
    // Text with a space between elements, so "<b>Ongoing</b><a>Fantasy</a>" doesn't read as one word
    const spacedText = (el) => {
      const parts = [];
      const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n = walk.nextNode(); n; n = walk.nextNode()) parts.push(n.nodeValue);
      return parts.join(" ").replace(/\s+/g, " ").trim();
    };
    function shStatus(doc) {
      for (const el of doc.querySelectorAll(".widget_fic_similar li, .fic_stats span, .rnd_stats, .copyright, [class*='status']")) {
        const m = spacedText(el).match(SH_STATUS);
        if (m) return m[1].toUpperCase();
      }
      const m = (doc.body ? doc.body.textContent : "").match(/Status\s*:?\s*(Ongoing|Completed|Hiatus|Dropped)/i);
      return m ? m[1].toUpperCase() : "UNKNOWN";
    }
    function shTocPage(doc) {
      return [...doc.querySelectorAll("a.toc_a")].map((a) => {
        const href = absFor(SH, a.getAttribute("href"));
        const id = (href.match(/\/chapter\/(\d+)/) || [])[1];
        return id ? { id: "sh" + id, title: txt(a) || "Chapter", url: href } : null;
      }).filter(Boolean);
    }
    function shParseFiction(doc, url) {
      const desc = doc.querySelector(".wi_fic_desc");
      if (desc) desc.querySelectorAll(".dots, .morelink").forEach((e) => e.remove());
      const coverEl = doc.querySelector("div.fic_image img");
      const total = parseInt(txt(doc.querySelector("span.cnt_toc")).replace(/,/g, ""), 10);
      return {
        id: fictionId(url), url: shSeriesUrl(url), source: "sh",
        title: txt(doc.querySelector("div.fic_title")) || metaContent(doc, ["og:title"]) || "Untitled",
        author: txt(doc.querySelector("span.auth_name_fic")) || "Unknown",
        status: shStatus(doc),
        coverUrl: absFor(SH, (coverEl && (coverEl.getAttribute("data-src") || coverEl.getAttribute("src"))) || metaContent(doc, ["og:image"])),
        genres: uniq([...doc.querySelectorAll("a.fic_genre, [property='genre']")].map(txt)),
        descriptionX: desc ? toXhtml(desc) : "",
        descriptionText: desc ? ([...desc.querySelectorAll("p")].map(txt).filter(Boolean).join(" ") || txt(desc)) : "",
        total: total > 0 ? total : null,
        firstPage: shTocPage(doc), // newest chapters first
      };
    }
    // Series page only: title, status, chapter total and the newest chapters
    async function shPeek(url) {
      const f = shParseFiction(await fetchDoc(shSeriesUrl(url), shHeaders(SH + "/")), url);
      if (!f.id) throw new Error("Not a Scribble Hub series link: " + url);
      return f;
    }
    // Full (or, with `known`, just-the-new-part) chapter list, oldest first. The list is paged
    // newest-first, so an update can stop at the first page that reaches a chapter it already has.
    async function shFiction(url, known) {
      const f = await shPeek(url);
      const seen = new Set(), newestFirst = [];
      const add = (list) => list.filter((c) => !seen.has(c.id)).map((c) => { seen.add(c.id); newestFirst.push(c); return c; }).length;
      // Newest first, so the first page that holds a chapter we already have ends the new part
      const reachedKnown = (list) => !!known && list.some((c) => known.has(c.id));
      add(f.firstPage);
      let partial = reachedKnown(f.firstPage), referer = f.url, page = 1;
      const perPage = Math.max(1, f.firstPage.length);
      while (!partial && f.firstPage.length && (f.total == null || newestFirst.length < f.total)) {
        if (stopRequested) throw new Error("Stopped.");
        page++;
        setStatus("Reading the chapter list, page " + page + (f.total ? " of " + Math.ceil(f.total / perPage) : "") + "\u2026");
        await sleep(SH_DELAY_MS);
        const u = f.url + "?toc=" + page;
        const list = shTocPage(await fetchDoc(u, shHeaders(referer)));
        referer = u;
        if (!add(list)) break; // past the end (the site sometimes returns an empty page)
        if (reachedKnown(list)) partial = true;
      }
      f.partial = !!partial;
      f.chapters = newestFirst.reverse();
      if (!f.total) f.total = f.chapters.length;
      return f;
    }
    function shParseSearch(doc) {
      let boxes = [...doc.querySelectorAll(".search_main_box")];
      if (!boxes.length) {
        // Fallback: one block per distinct series link
        const byId = new Map();
        for (const a of doc.querySelectorAll('a[href*="/series/"]')) {
          const id = fictionId(absFor(SH, a.getAttribute("href")));
          if (id && !byId.has(id)) byId.set(id, a.closest("li, article, div") || a);
        }
        boxes = [...byId.values()];
      }
      return boxes.map((box) => {
        const a = box.querySelector(".search_title a") || box.querySelector('a[href*="/series/"]');
        if (!a) return null;
        const url = shSeriesUrl(absFor(SH, a.getAttribute("href")));
        const id = fictionId(url);
        if (!id) return null;
        const img = box.querySelector("img");
        const t = spacedText(box);
        const genres = uniq([...box.querySelectorAll("a.fic_genre")].map(txt));
        const clone = box.cloneNode(true);
        clone.querySelectorAll(".search_title, .search_stats, [class*='stat'], .fdi, a.fic_genre, .search_genre, img").forEach((e) => e.remove());
        const st = t.match(SH_STATUS);
        const coverSrc = img ? img.getAttribute("data-src") || img.getAttribute("src") || "" : "";
        return {
          id, url, source: "sh", title: txt(a),
          status: st ? st[1].toUpperCase() : "UNKNOWN",
          chapters: num(t.match(/([\d,]+)\s+Chapters?/i)),
          genres,
          coverUrl: coverSrc && !/noimage|nocover|^data:/i.test(coverSrc) ? absFor(SH, coverSrc) : "",
          blurb: txt(clone).replace(txt(a), "").trim().slice(0, 400),
        };
      }).filter(Boolean);
    }

    // ---- Archive of Our Own (selectors follow WebToEpub's ArchiveOfOurOwnParser)
    const aoWorkId = (url) => ((url || "").match(/\/works\/(\d+)/) || [])[1] || null;
    const aoAdult = (u) => u + (u.includes("?") ? "&" : "?") + "view_adult=true";
    const aoWorkUrl = (url) => AO + "/works/" + aoWorkId(url);
    // "Chapters: 3/5" or "3/?" -> counts and status
    function aoChapters(text) {
      const m = (text || "").match(/(\d[\d,]*)\s*\/\s*(\d[\d,]*|\?)/);
      if (!m) return { done: null, planned: null, status: "UNKNOWN" };
      const done = parseInt(m[1].replace(/,/g, ""), 10);
      const planned = m[2] === "?" ? null : parseInt(m[2].replace(/,/g, ""), 10);
      return { done, planned, status: planned != null && done >= planned ? "COMPLETED" : "ONGOING" };
    }
    function aoCheckOpen(doc, url) {
      if (doc.querySelector("#chapters, h2.title.heading, ol.chapter.index, li.work.blurb, #workskin")) return;
      const t = txt(doc.body);
      if (/registered users|log in|sign in/i.test(t)) throw new Error("This AO3 work is only for logged-in AO3 users, so it can't be downloaded here.");
      throw new Error("AO3 page didn't load as expected (see " + ROOT + "/debug-last-page.html) \u2014 " + url);
    }
    function aoMeta(doc, url) {
      const meta = doc.querySelector("dl.work.meta, dl.meta");
      const tags = (sel) => uniq([...(meta || doc).querySelectorAll(sel)].map(txt));
      const ch = aoChapters(txt(doc.querySelector("dd.chapters")));
      const summary = doc.querySelector("div.summary blockquote, .summary .userstuff");
      return {
        id: "ao-" + aoWorkId(url), url: aoWorkUrl(url), source: "ao",
        title: txt(doc.querySelector("h2.title.heading, h2.heading")) || "Untitled",
        author: uniq([...doc.querySelectorAll("a[rel='author']")].map(txt)).join(", ") || "Anonymous",
        status: ch.status, coverUrl: "",
        genres: tags("dd.fandom a").concat(tags("dd.freeform a").slice(0, 6)),
        descriptionX: summary ? toXhtml(summary) : "",
        descriptionText: summary ? ([...summary.querySelectorAll("p")].map(txt).filter(Boolean).join(" ") || txt(summary)) : "",
        total: ch.done,
      };
    }
    // AO3 chapter text, wrapped so parseChapter can clean it like the other sites
    function aoBodyDoc(userstuff) {
      const d = new DOMParser().parseFromString("<div id=\"ao3body\"></div>", "text/html");
      const box = d.getElementById("ao3body");
      box.innerHTML = userstuff ? userstuff.innerHTML : "";
      box.querySelectorAll("h3.landmark").forEach((e) => e.remove());
      return d;
    }
    const aoTitle = (n, name) => {
      const rest = (name || "").replace(/^\s*\d+\.\s*/, "").trim();
      return "Chapter " + n + (rest && !new RegExp("^chapter\\s+" + n + "$", "i").test(rest) ? ": " + rest : "");
    };
    // Full work on one page: metadata plus every chapter's text in a single request
    async function aoFullWork(url) {
      const u = aoAdult(aoWorkUrl(url) + "?view_full_work=true");
      const doc = await fetchDoc(u);
      aoCheckOpen(doc, u);
      const f = aoMeta(doc, url);
      const blocks = [...doc.querySelectorAll("#chapters > div.chapter")];
      if (!blocks.length) {
        // One-shot work: no chapter list, the text sits straight in #chapters
        const body = doc.querySelector("#chapters .userstuff") || doc.querySelector("#chapters");
        f.chapters = [{ id: "ao-w" + aoWorkId(url), title: f.title, url: aoAdult(aoWorkUrl(url)), doc: aoBodyDoc(body) }];
      } else {
        f.chapters = blocks.map((b, i) => {
          const a = b.querySelector("h3.title a");
          const cid = ((a && a.getAttribute("href")) || "").match(/\/chapters\/(\d+)/);
          const head = txt(b.querySelector("h3.title"));
          const name = head.replace(/^Chapter\s+\d+\s*:?\s*/i, "");
          return {
            id: cid ? "ao" + cid[1] : "ao-" + aoWorkId(url) + "-" + (i + 1),
            title: aoTitle(i + 1, name),
            url: cid ? aoAdult(AO + "/works/" + aoWorkId(url) + "/chapters/" + cid[1]) : null,
            doc: aoBodyDoc(b.querySelector("div.userstuff[role='article'], div.userstuff")),
          };
        });
      }
      f.total = Math.max(f.total || 0, f.chapters.length);
      return f;
    }
    // Light chapter list (no text): /works/<id>/navigate
    async function aoChapterList(url) {
      const u = aoAdult(aoWorkUrl(url) + "/navigate");
      const doc = await fetchDoc(u);
      aoCheckOpen(doc, u);
      const list = [...doc.querySelectorAll("ol.chapter.index a, ol.index a")].map((a, i) => {
        const cid = (a.getAttribute("href") || "").match(/\/chapters\/(\d+)/);
        return cid ? { id: "ao" + cid[1], title: aoTitle(i + 1, txt(a)), url: aoAdult(AO + "/works/" + aoWorkId(url) + "/chapters/" + cid[1]) } : null;
      }).filter(Boolean);
      return { doc, list };
    }
    // For an update: metadata from the work page + the light list; text is fetched per new chapter
    async function aoFiction(url, known) {
      if (!known) return aoFullWork(url);
      const wu = aoAdult(aoWorkUrl(url));
      const wdoc = await fetchDoc(wu);
      aoCheckOpen(wdoc, wu);
      const f = aoMeta(wdoc, url);
      if (!wdoc.querySelector("li.chapter, #chapter_index, ul#chapter_index")) {
        // Still a one-shot: nothing new can appear except as a new chapter list
        f.chapters = [{ id: "ao-w" + aoWorkId(url), title: f.title, url: wu, doc: aoBodyDoc(wdoc.querySelector("#chapters .userstuff") || wdoc.querySelector("#chapters")) }];
        return f;
      }
      await sleep(AO_DELAY_MS);
      f.chapters = aoKeepOneShotId((await aoChapterList(url)).list, url, known);
      f.total = Math.max(f.total || 0, f.chapters.length);
      return f;
    }
    // A one-shot was saved as "ao-w<work>"; if it grew more chapters, that text is chapter 1
    function aoKeepOneShotId(list, url, known) {
      const w = "ao-w" + aoWorkId(url);
      if (known && known.has(w) && list.length && !known.has(list[0].id)) list[0] = Object.assign({}, list[0], { id: w });
      return list;
    }
    async function aoChapterDoc(c) {
      const doc = await fetchDoc(c.url);
      aoCheckOpen(doc, c.url);
      return aoBodyDoc(doc.querySelector("#chapters div.userstuff[role='article']") || doc.querySelector("#chapters .userstuff"));
    }
    function aoParseSearch(doc) {
      return [...doc.querySelectorAll("li.work.blurb, li.blurb.work")].map((li) => {
        const a = [...li.querySelectorAll("h4.heading a")].find((x) => /\/works\/\d+/.test(x.getAttribute("href") || ""));
        if (!a) return null;
        const url = aoWorkUrl(absFor(AO, a.getAttribute("href")));
        const ch = aoChapters(txt(li.querySelector("dd.chapters")));
        let status = ch.status;
        if (li.querySelector(".complete-yes")) status = "COMPLETED";
        else if (li.querySelector(".complete-no") && status === "UNKNOWN") status = "ONGOING";
        const summary = li.querySelector("blockquote.summary, .summary");
        return {
          id: "ao-" + aoWorkId(url), url, source: "ao", title: txt(a),
          author: uniq([...li.querySelectorAll("a[rel='author']")].map(txt)).join(", "),
          status, chapters: ch.done,
          genres: uniq([...li.querySelectorAll("h5.fandoms a")].map(txt)).concat(uniq([...li.querySelectorAll("li.freeforms a")].map(txt)).slice(0, 4)),
          coverUrl: "",
          blurb: txt(summary).slice(0, 400),
        };
      }).filter(Boolean);
    }

    // One entry point for every site. `known`: chapter ids already in the book (lets Scribble Hub stop early).
    async function getFiction(url, known) {
      if (sourceOf(url) === "sh") return shFiction(url, known);
      if (sourceOf(url) === "ao") return aoFiction(url, known);
      const f = parseFiction(await fetchDoc(url), url);
      f.source = "rr";
      f.total = f.chapters.length;
      return f;
    }

    // imgCtx: { images: Map(name -> jpeg bytes), failed: Set } to keep chapter images, or null to drop them
    async function parseChapter(doc, imgCtx, site) {
      const body = site === "ao" ? doc.querySelector("#ao3body") : site === "sh"
        ? doc.querySelector("#chp_raw") || doc.querySelector("div.fic_row")
        : doc.querySelector(".chapter-inner.chapter-content") || doc.querySelector("div.chapter-inner") || doc.querySelector(".chapter-content");
      if (!body) throw new Error("Chapter text not found on the page (see " + ROOT + "/debug-last-page.html)");
      // Royal Road hides anti-piracy lines with random classes set to display:none.
      const hidden = new Set();
      doc.querySelectorAll("style").forEach((s) => {
        for (const m of s.textContent.matchAll(/\.([A-Za-z0-9_-]+)\s*\{[^}]*display\s*:\s*none/gi)) hidden.add(m[1]);
      });
      body.querySelectorAll("[class], [style]").forEach((e) => {
        if ([...e.classList].some((c) => hidden.has(c))) e.remove();
        else if (/display\s*:\s*none/i.test(e.getAttribute("style") || "")) e.remove();
      });
      // Scribble Hub: author notes, news boxes, avatars, spoiler toggles
      body.querySelectorAll(".wi_authornotes, .wi_news, .p-avatar-wrap, .sp-body > .spdiv").forEach((e) => e.remove());
      // Remove old "<-->" next/previous separators
      [...body.querySelectorAll("p")].forEach((p) => { if (txt(p) === "<-->") p.remove(); });

      if (imgCtx) {
        for (const img of [...body.querySelectorAll("img")]) {
          const src = img.getAttribute("src") || img.getAttribute("data-src") || "";
          if (!src) { img.remove(); continue; }
          let url;
          try { url = src.startsWith("data:") ? src : new URL(src, site === "sh" ? SH : site === "ao" ? AO : RR).href; } catch (e) { img.remove(); continue; }
          const name = "img-" + hash(url) + ".jpg";
          if (imgCtx.failed.has(name)) { img.remove(); continue; }
          if (!imgCtx.images.has(name)) {
            try {
              const bytes = await toJpeg(await fetchBlob(url, "img.bin"), 480, 800, 0.75);
              if (!bytes) throw new Error("empty image");
              imgCtx.images.set(name, bytes);
            } catch (e) {
              log("Image skipped (" + e.message + ")");
              imgCtx.failed.add(name);
              img.remove();
              continue;
            }
          }
          img.setAttribute("data-epub", "images/" + name);
        }
      }
      return toXhtml(body);
    }

    // HTML \u2192 clean XHTML (allow-list of tags, no attributes except centring and kept images)
    const KEEP = new Set(["p", "div", "br", "hr", "em", "i", "strong", "b", "u", "s", "del", "sup", "sub",
      "blockquote", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "table", "thead", "tbody", "tr",
      "td", "th", "pre", "code"]);
    const DROP = new Set(["script", "style", "iframe", "noscript", "svg", "button", "form", "input",
      "select", "textarea", "video", "audio", "object", "embed"]);
    function toXhtml(node) {
      let out = "";
      for (const n of node.childNodes) {
        if (n.nodeType === 3) { out += esc(n.nodeValue); continue; }
        if (n.nodeType !== 1) continue;
        const tag = n.tagName.toLowerCase();
        if (DROP.has(tag)) continue;
        if (tag === "img") {
          const p = n.getAttribute("data-epub");
          if (p) out += '<img src="' + esc(p) + '" alt="' + esc(n.getAttribute("alt") || "") + '"/>';
          continue;
        }
        const inner = toXhtml(n);
        if (!KEEP.has(tag)) { out += inner; continue; }
        if (tag === "br" || tag === "hr") { out += "<" + tag + "/>"; continue; }
        const center = /text-align\s*:\s*center/i.test(n.getAttribute("style") || "") || n.getAttribute("align") === "center";
        out += "<" + tag + (center ? ' class="center"' : "") + ">" + inner + "</" + tag + ">";
      }
      return out;
    }

    // ---- EPUB building
    const CSS_TEXT =
      "body{margin:0 4%;line-height:1.45}h1,h2{text-align:center;margin:1em 0 .8em}p{margin:0 0 .7em}" +
      ".center{text-align:center}table{border-collapse:collapse}td,th{border:1px solid #888;padding:.2em .4em}" +
      ".meta{text-align:center;font-size:.9em}img{max-width:100%;height:auto}img.cover{max-height:100%}";

    function page(title, bodyX, extraHead) {
      return '<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n' +
        '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en" xml:lang="en">\n' +
        "<head><meta charset=\"utf-8\"/><title>" + esc(title) + "</title>" +
        '<link rel="stylesheet" type="text/css" href="style.css"/>' + (extraHead || "") + "</head>\n" +
        "<body>\n" + bodyX + "\n</body>\n</html>\n";
    }
    const chapterPage = (c, bodyX) =>
      page(c.title, '<section epub:type="chapter"><h2>' + esc(c.title) + "</h2>\n" + bodyX + "\n</section>");

    async function buildEpub(meta, chapters, coverBytes, images) {
      const JSZip = await loadJSZip();
      const zip = new JSZip();
      const uid = "royalroad-" + meta.id;
      zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
      zip.file("META-INF/container.xml",
        '<?xml version="1.0" encoding="utf-8"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">' +
        '<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>\n');
      zip.file("META-INF/royalroad.json", JSON.stringify({
        fictionId: meta.id, url: meta.url, title: meta.title, author: meta.author, status: meta.status,
        updated: meta.updated, genres: meta.genres || [], range: meta.range || null, chapters: chapters.map((c) => ({ id: c.id, title: c.title, file: c.file })),
      }));
      zip.file("OEBPS/style.css", CSS_TEXT);

      const items = ['<item id="css" href="style.css" media-type="text/css"/>',
        '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
        '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>'];
      const spine = [];
      if (coverBytes) {
        zip.file("OEBPS/cover.jpg", coverBytes);
        zip.file("OEBPS/cover.xhtml", page("Cover", '<div class="center"><img class="cover" src="cover.jpg" alt="Cover"/></div>'));
        items.push('<item id="cover-img" href="cover.jpg" media-type="image/jpeg" properties="cover-image"/>',
          '<item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>');
        spine.push('<itemref idref="cover"/>');
      }
      zip.file("OEBPS/title.xhtml", page(meta.title,
        "<h1>" + esc(meta.title) + "</h1>" +
        '<p class="meta">by ' + esc(meta.author) + "</p>" +
        '<p class="meta">' + esc(meta.status) + " \u00B7 " + chapters.length + " chapters \u00B7 updated " +
        esc(meta.updated.slice(0, 10)) + "</p>" +
        (meta.genres && meta.genres.length ? '<p class="meta">Genres: ' + esc(meta.genres.join(", ")) + "</p>" : "") +
        '<p class="meta">' + esc(meta.url) + "</p><hr/>" + (meta.descriptionX || "")));
      items.push('<item id="title" href="title.xhtml" media-type="application/xhtml+xml"/>');
      spine.push('<itemref idref="title"/>');

      chapters.forEach((c, i) => {
        zip.file("OEBPS/" + c.file, c.xhtml);
        items.push('<item id="c' + i + '" href="' + c.file + '" media-type="application/xhtml+xml"/>');
        spine.push('<itemref idref="c' + i + '"/>');
      });
      // Chapter images (only those a chapter still references)
      const used = new Set();
      for (const c of chapters) for (const m of c.xhtml.matchAll(/src="images\/([^"]+)"/g)) used.add(m[1]);
      let n = 0;
      for (const [name, bytes] of images || []) {
        if (!used.has(name)) continue;
        zip.file("OEBPS/images/" + name, bytes);
        items.push('<item id="i' + (n++) + '" href="images/' + name + '" media-type="image/jpeg"/>');
      }

      zip.file("OEBPS/content.opf",
        '<?xml version="1.0" encoding="utf-8"?>\n<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">\n' +
        '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">' +
        '<dc:identifier id="uid">' + esc(uid) + "</dc:identifier>" +
        "<dc:title>" + esc(meta.title) + "</dc:title><dc:creator>" + esc(meta.author) + "</dc:creator>" +
        (meta.genres || []).map((g) => "<dc:subject>" + esc(g) + "</dc:subject>").join("") +
        "<dc:language>en</dc:language><dc:publisher>" + esc(meta.publisher || "Royal Road") + "</dc:publisher><dc:source>" + esc(meta.url) + "</dc:source>" +
        (meta.descriptionText ? "<dc:description>" + esc(meta.descriptionText) + "</dc:description>" : "") +
        '<meta property="dcterms:modified">' + nowIso() + "</meta>" +
        (coverBytes ? '<meta name="cover" content="cover-img"/>' : "") +
        "</metadata>\n<manifest>" + items.join("") + '</manifest>\n<spine toc="ncx">' + spine.join("") +
        "</spine>\n</package>\n");

      zip.file("OEBPS/nav.xhtml", page("Contents",
        '<nav epub:type="toc" id="toc"><h2>Contents</h2><ol>' +
        chapters.map((c) => '<li><a href="' + c.file + '">' + esc(c.title) + "</a></li>").join("") + "</ol></nav>"));
      zip.file("OEBPS/toc.ncx",
        '<?xml version="1.0" encoding="utf-8"?>\n<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">' +
        '<head><meta name="dtb:uid" content="' + esc(uid) + '"/></head><docTitle><text>' + esc(meta.title) +
        "</text></docTitle><navMap>" +
        chapters.map((c, i) => '<navPoint id="n' + i + '" playOrder="' + (i + 1) + '"><navLabel><text>' + esc(c.title) +
          '</text></navLabel><content src="' + c.file + '"/></navPoint>').join("") +
        "</navMap></ncx>\n");

      return zip.generateAsync({ type: "blob", mimeType: "application/epub+zip", compression: "DEFLATE",
        compressionOptions: { level: 6 } });
    }

    // Cover: small grayscale JPEG sized for the X4 screen
    async function makeCover(url) {
      if (!url || /nocover/i.test(url)) return null;
      try { return await toJpeg(await fetchBlob(url, "cover.bin"), 480, 800, 0.8); }
      catch (e) { log("Cover skipped (" + e.message + ")"); return null; }
    }

    // Generated cover for books without one (all AO3 works, placeholder covers elsewhere):
    // 480x800 grayscale, high contrast for e-ink, with a pattern seeded by the title so
    // books are easy to tell apart in the library.
    async function generateCover(meta) {
      try {
        const W = 480, H = 800, M = 28;
        const c = document.createElement("canvas");
        c.width = W; c.height = H;
        const g = c.getContext("2d");
        let seed = stdHash32(meta.title + "|" + meta.author) || 1;
        const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };
        const SERIF = "Georgia, 'Noto Serif', 'Times New Roman', serif";

        g.fillStyle = "#fff"; g.fillRect(0, 0, W, H);
        // Pattern band at the top: one of three motifs
        const bandH = 300;
        g.save();
        g.beginPath(); g.rect(M, M, W - 2 * M, bandH); g.clip();
        g.fillStyle = "#1a1a1a"; g.fillRect(M, M, W - 2 * M, bandH);
        const motif = Math.floor(rnd() * 3);
        g.strokeStyle = "#fff"; g.fillStyle = "#fff";
        if (motif === 0) {            // concentric rings
          const cx = M + rnd() * (W - 2 * M), cy = M + rnd() * bandH;
          for (let r = 18; r < 700; r += 14 + rnd() * 16) { g.lineWidth = 1 + rnd() * 3; g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.stroke(); }
        } else if (motif === 1) {     // diagonal bars
          const step = 22 + rnd() * 20, ang = rnd() > 0.5 ? 1 : -1;
          for (let x = -bandH; x < W + bandH; x += step) {
            g.lineWidth = 2 + rnd() * 8; g.beginPath(); g.moveTo(x, M); g.lineTo(x + ang * bandH, M + bandH); g.stroke();
          }
        } else {                      // field of dots
          for (let i = 0; i < 90; i++) {
            g.globalAlpha = 0.35 + rnd() * 0.65;
            g.beginPath(); g.arc(M + rnd() * (W - 2 * M), M + rnd() * bandH, 2 + rnd() * 16, 0, Math.PI * 2); g.fill();
          }
          g.globalAlpha = 1;
        }
        g.restore();

        // Frame
        g.strokeStyle = "#000"; g.lineWidth = 4; g.strokeRect(M / 2, M / 2, W - M, H - M);

        // Text layout: measure everything first, then shrink the title (and the pattern band)
        // until title + author fit above the tags and site name at the bottom.
        const maxW = W - 2 * M - 24;
        const wrap = (text, font) => {
          g.font = font;
          const words = String(text).split(/\s+/).filter(Boolean), lines = [];
          let line = "";
          for (let w of words) {
            while (g.measureText(w).width > maxW && w.length > 1) { // break very long words
              let k = w.length - 1;
              while (k > 1 && g.measureText(w.slice(0, k) + "-").width > maxW) k--;
              if (line) { lines.push(line); line = ""; }
              lines.push(w.slice(0, k) + "-"); w = w.slice(k);
            }
            const t = line ? line + " " + w : w;
            if (g.measureText(t).width > maxW && line) { lines.push(line); line = w; } else line = t;
          }
          if (line) lines.push(line);
          return lines;
        };
        const tags = (meta.genres || []).slice(0, 3).join(" \u00B7 ");
        const tagLines = tags ? wrap(tags.toUpperCase(), "15px " + SERIF).slice(0, 2) : [];
        const authorLines = wrap(meta.author || "", "italic 26px " + SERIF).slice(0, 2);
        const bottomTop = H - M - 40 - (tagLines.length ? 18 + tagLines.length * 20 : 0); // text must end above this
        // From the top of the title to the bottom of the last author line (as drawn below)
        const blockH = (n, sz) => sz + (n - 1) * sz * 1.18 + sz + 10 + 40 + (authorLines.length - 1) * 32 + 8;
        let size = 52, lines, top = M + bandH + 40;
        for (; size >= 20; size -= 2) {
          lines = wrap(meta.title, "bold " + size + "px " + SERIF);
          if (lines.length > 6) continue;
          const need = blockH(lines.length, size) + 6;
          if (top + need <= bottomTop) break;
          // Give the title room by trimming the pattern band (down to 140px)
          const spare = bottomTop - need - (M + 140 + 40);
          if (spare >= 0) { top = bottomTop - need; break; }
        }
        if (lines.length > 6) { lines = lines.slice(0, 6); lines[5] = lines[5].replace(/.{0,2}$/, "\u2026"); }
        if (top < M + bandH + 40) { g.fillStyle = "#fff"; g.fillRect(M, top - 40, W - 2 * M, M + bandH - (top - 40)); }

        g.fillStyle = "#000"; g.textAlign = "center"; g.textBaseline = "alphabetic";
        g.font = "bold " + size + "px " + SERIF;
        let y = top + size;
        for (const l of lines) { g.fillText(l, W / 2, y); y += size * 1.18; }
        // Rule + author
        y += 10 - size * 0.18;
        g.lineWidth = 2; g.beginPath(); g.moveTo(W / 2 - 60, y); g.lineTo(W / 2 + 60, y); g.stroke();
        y += 40;
        g.font = "italic 26px " + SERIF;
        for (const l of authorLines) { g.fillText(l, W / 2, y); y += 32; }
        // Fandom / genres and the site at the bottom
        if (tagLines.length) {
          g.font = "15px " + SERIF;
          let ty = H - M - 52 - (tagLines.length - 1) * 20;
          for (const l of tagLines) { g.fillText(l, W / 2, ty); ty += 20; }
        }
        g.font = "bold 14px " + SERIF;
        g.fillText(({ ao: "ARCHIVE OF OUR OWN", sh: "SCRIBBLE HUB", rr: "ROYAL ROAD" })[meta.source] || "", W / 2, H - M - 14);

        const out = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.85));
        return out ? new Uint8Array(await out.arrayBuffer()) : null;
      } catch (e) {
        log("Couldn't draw a cover (" + e.message + ")");
        return null;
      }
    }

    // ---- library index (/RoyalRoad/library.json)
    async function loadLibrary() {
      const t = await readSd(ROOT + "/" + LIB_FILE);
      try { return t ? JSON.parse(t) : {}; } catch (e) { return {}; }
    }
    async function saveLibrary(lib) {
      await uploadSd(ROOT, LIB_FILE, new Blob([JSON.stringify(lib, null, 1)], { type: "application/json" }));
    }

    // ---- the main job: download a fiction, or add its new chapters
    // opts: { fresh: re-download everything, range: {from, to} or null, images: keep chapter images }
    async function sync(url, opts) {
      opts = opts || {};
      const site = sourceOf(url);
      const SRC = SOURCES[site];
      if (site === "sh") url = shSeriesUrl(url);
      if (site === "ao") url = aoWorkUrl(url);
      const id = fictionId(url);
      if (!id) throw new Error("Not a novel link: " + url);
      const lib = await loadLibrary();
      const prev = lib[id] || {};
      const bookDir = prev.dir || SRC.dir;
      await ensureRoot(bookDir);
      const range = opts.range || prev.range || null;

      // What we already have: read it from the existing EPUB
      const have = new Map();
      const images = new Map();
      let coverBytes = null;
      let oldSpine = null; // spine of the book currently on the reader, to carry the reading position over
      if (prev.file) {
        // A save interrupted between delete and rename leaves only "<file>.new"
        const old = (await readSd(bookDir + "/" + prev.file, "blob")) || (await readSd(bookDir + "/" + prev.file + ".new", "blob"));
        if (old) {
          try {
            const JSZip = await loadJSZip();
            const z = await JSZip.loadAsync(old);
            const info = JSON.parse(await z.file("META-INF/royalroad.json").async("string"));
            const cov = z.file("OEBPS/cover.jpg");
            oldSpine = spineOf(!!cov, info.chapters.map((c) => c.id));
            if (!opts.fresh) {
              for (const c of info.chapters) {
                const f = z.file("OEBPS/" + c.file);
                if (f) have.set(c.id, { id: c.id, title: c.title, file: c.file, xhtml: await f.async("string") });
              }
              for (const f of z.file(/^OEBPS\/images\/[^/]+$/)) images.set(f.name.split("/").pop(), await f.async("uint8array"));
              if (cov) coverBytes = await cov.async("uint8array");
              log("Existing EPUB has " + have.size + " chapters.");
            }
          } catch (e) {
            log("Existing EPUB could not be read, rebuilding it (" + e.message + ")");
            have.clear();
            images.clear();
          }
        }
      }

      log("Reading " + SRC.name + " novel page\u2026");
      // A full chapter list is needed for a new book or a range; otherwise Scribble Hub can stop early
      const fic = await getFiction(url, opts.fresh || range || !have.size ? null : new Set(have.keys()));
      if (!fic.id || !fic.chapters.length) throw new Error("No chapters found on " + url + " (see " + ROOT + "/debug-last-page.html)");
      if (fic.partial) {
        // Only the newest part of the list was read: keep the book's order, then add what's new
        const known = [...have.values()].map((c) => ({ id: c.id, title: c.title, url: null }));
        fic.chapters = known.concat(fic.chapters.filter((c) => !have.has(c.id)));
      }
      setStatus(fic.title + " \u2014 " + fic.status + ", " + fic.total + " chapters online");

      // Chapter range: one given now wins, else the one remembered for this novel, else all.
      // "to" left empty means "up to the latest", so later updates keep adding new chapters.
      const from = range ? Math.max(1, range.from || 1) : 1;
      const to = range && range.to ? Math.min(range.to, fic.chapters.length) : fic.chapters.length;
      if (from > fic.chapters.length) throw new Error("This novel only has " + fic.chapters.length + " chapters.");
      if (to < from) throw new Error("Chapter range " + from + "\u2013" + to + " is empty.");
      const wanted = fic.chapters.slice(from - 1, to);
      if (range) log("Chapter range: " + from + "\u2013" + (range.to ? to : "latest") + " (" + wanted.length + " chapters)");

      // File name: keep the existing one, avoid clashing with another novel of the same title
      let file = prev.file;
      if (!file) {
        file = safeName(fic.title) + ".epub";
        if (Object.keys(lib).some((k) => k !== id && lib[k].file === file && (lib[k].dir || ROOT) === bookDir)) {
          file = safeName(fic.title) + " (" + id + ").epub";
        }
      }
      if (!coverBytes) coverBytes = await makeCover(fic.coverUrl);
      if (!coverBytes) {
        coverBytes = await generateCover(Object.assign({ source: site }, fic));
        if (coverBytes) log("No cover on " + SRC.name + ", so one was drawn for this book.");
      }

      const entry = (count) => ({ title: fic.title, author: fic.author, url: fic.url, file, dir: bookDir, source: site,
        status: fic.status, chapters: count, online: fic.total, genres: fic.genres, coverUrl: fic.coverUrl, range,
        checked: nowIso(), ids: [...have.keys()], newCount: wanted.filter((c) => !have.has(c.id)).length });

      const missing = wanted.filter((c) => !have.has(c.id));
      if (!missing.length) {
        log("Up to date \u2014 " + have.size + " chapters in the book.");
        lib[id] = entry(have.size);
        await saveLibrary(lib);
        return { added: 0, total: have.size };
      }
      log(missing.length + " chapter(s) " + (missing[0].doc ? "to add." : "to download.") +
        (site === "sh" ? " Scribble Hub asks for a few seconds between pages, so this takes a while." : ""));

      const save = async (final) => {
        // Keep the site's order; chapters the author deleted online stay at the end.
        const ordered = fic.chapters.filter((c) => have.has(c.id)).map((c) => have.get(c.id));
        const online = new Set(fic.chapters.map((c) => c.id));
        for (const c of have.values()) if (!online.has(c.id)) ordered.push(c);
        const meta = Object.assign({}, fic, { updated: nowIso(), range, publisher: SRC.name });
        log((final ? "Building" : "Saving progress:") + " EPUB with " + ordered.length + " chapters\u2026");
        const blob = await buildEpub(meta, ordered, coverBytes, images);
        const bookPath = bookDir + "/" + file;
        const state = oldSpine ? await readReaderState(bookPath) : null;
        log("Sending " + Math.round(blob.size / 1024) + " KB to the reader\u2026");
        await uploadSd(bookDir, file, blob);
        const newSpine = spineOf(!!coverBytes, ordered.map((c) => c.id));
        if (state) {
          // Same chapter, found by id, even if chapters were inserted or a cover appeared
          const fromSpine = oldSpine;
          const mapIdx = (i) => { const at = newSpine.indexOf(fromSpine[i]); return at >= 0 ? at : Math.min(i, newSpine.length - 1); };
          const describe = (idx) => { const ch = ordered[idx - (newSpine.length - ordered.length)]; return ch ? " (" + ch.title + ")" : ""; };
          await restoreReaderState(bookPath, state, mapIdx, describe);
        }
        oldSpine = newSpine; // a later checkpoint replaces this version
        lib[id] = entry(ordered.length);
        await saveLibrary(lib);
      };

      const imgCtx = opts.images === false ? null : { images, failed: new Set() };
      const chapterHeaders = site === "sh" ? shHeaders(fic.url) : null;
      let added = 0;
      for (let i = 0; i < missing.length; i++) {
        const c = missing[i];
        if (stopRequested) { log("Stopped."); break; }
        setStatus("Chapter " + (i + 1) + "/" + missing.length + ": " + c.title);
        let bodyX = null;
        const fetched = !c.doc; // AO3's full-work page already brought every chapter's text
        for (let attempt = 1; attempt <= 3 && bodyX == null; attempt++) {
          try {
            const doc = c.doc || (site === "ao" ? await aoChapterDoc(c) : await fetchDoc(c.url, chapterHeaders));
            bodyX = await parseChapter(doc, imgCtx, site);
          }
          catch (e) {
            if (attempt === 3) throw new Error("Chapter \"" + c.title + "\": " + e.message);
            log("Retrying \"" + c.title + "\" (" + e.message + ")");
            await sleep(SRC.delay * 3 * attempt);
          }
        }
        delete c.doc;
        const fileName = "ch-" + c.id + ".xhtml";
        have.set(c.id, { id: c.id, title: c.title, file: fileName, xhtml: chapterPage(c, bodyX) });
        added++;
        if (added % CHECKPOINT_EVERY === 0 && i < missing.length - 1) await save(false);
        if (fetched && i < missing.length - 1) await sleep(SRC.delay);
      }
      if (added) await save(true);
      log("Done: " + added + " new chapter(s), " + have.size + " in the book \u2192 " + bookDir + "/" + file);
      return { added, total: have.size };
    }

    // ------------------------------------------------------------ UI
    const LISTS = [["trending", "Trending"], ["best-rated", "Best Rated"], ["rising-stars", "Rising Stars"],
      ["weekly-popular", "Popular This Week"], ["latest-updates", "Latest Updates"],
      ["active-popular", "Popular Ongoing"], ["complete", "Popular Completed"]];
    const GENRES = [["", "All genres"], ["action", "Action"], ["adventure", "Adventure"], ["comedy", "Comedy"],
      ["contemporary", "Contemporary"], ["drama", "Drama"], ["fantasy", "Fantasy"], ["historical", "Historical"],
      ["horror", "Horror"], ["mystery", "Mystery"], ["psychological", "Psychological"], ["romance", "Romance"],
      ["satire", "Satire"], ["sci_fi", "Sci-fi"], ["tragedy", "Tragedy"], ["litrpg", "LitRPG"],
      ["progression", "Progression"], ["gamelit", "GameLit"]];
    const opt = (pairs) => pairs.map(([v, t]) => '<option value="' + v + '">' + t + "</option>").join("");

    container.innerHTML =
      '<div class="rr">' +
      "<style>.rr input{width:100%;box-sizing:border-box;padding:8px;margin:4px 0}.rr button{padding:6px 10px;margin:2px 4px 2px 0}" +
      ".rr .card{border:1px solid #8884;border-radius:6px;padding:8px;margin:8px 0}.rr .muted{opacity:.7;font-size:.9em}" +
      ".rr pre{white-space:pre-wrap;max-height:160px;overflow:auto;font-size:.85em;background:#8881;padding:6px;margin:4px 0}" +
      ".rr .blurb{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;cursor:pointer}" +
      ".rr .opts input[type=number]{width:5.5em;display:inline-block;margin:4px 2px}.rr .opts label{display:block;margin:4px 0}" +
      ".rr .opts input[type=checkbox]{width:auto;display:inline;margin:0 4px 0 0}.rr .tags{font-size:.85em;opacity:.8}" +
      ".rr select{padding:6px;margin:3px 4px 3px 0;max-width:100%}.rr .browse{margin:6px 0}" +
      ".rr .card::after{content:'';display:block;clear:both}" +
      ".rr img.cover{float:left;width:64px;height:96px;object-fit:cover;border-radius:4px;margin:0 10px 4px 0;background:#8882}" +
      ".rr .new{font-weight:bold;opacity:1}.rr #rr-linkbox{margin:6px 0}" +
      ".rr .blurb.open{display:block;-webkit-line-clamp:unset;overflow:visible}.rr #rr-status{font-weight:bold;opacity:1}</style>" +
      "<h2>Web Novels</h2>" +
      '<select id="rr-src"><option value="rr">Royal Road</option><option value="sh">Scribble Hub</option><option value="ao">AO3</option></select>' +
      '<input id="rr-q" placeholder="Search a title, or paste a novel link"/>' +
      '<button id="rr-go">Search</button><button id="rr-stop">Stop</button>' +
      '<div class="browse" id="rr-browsebox">Browse <select id="rr-list">' + opt(LISTS) + '</select><select id="rr-genre">' + opt(GENRES) +
      '</select><select id="rr-st">' + opt([["", "Any status"], ["ONGOING", "Ongoing"], ["COMPLETED", "Completed"]]) +
      '</select><button id="rr-browse">Browse</button></div>' +
      '<div class="opts">Chapters <input id="rr-from" type="number" min="1" placeholder="from"/>' +
      ' to <input id="rr-to" type="number" min="1" placeholder="latest"/>' +
      '<label><input id="rr-img" type="checkbox"/> Include chapter images</label>' +
      '<div class="muted">Leave the range empty for the whole novel, or what you set before. Empty "to" keeps adding new chapters. ' +
      "The status filter applies to search and browse results.</div></div>" +
      '<p id="rr-status" class="muted"></p><pre id="rr-log"></pre>' +
      '<div id="rr-res"></div><button id="rr-more" style="display:none">Show more</button>' +
      '<h3>My novels</h3><div id="rr-lib" class="muted">Loading\u2026</div>' +
      '<button id="rr-check">Check all</button><button id="rr-all">Update all</button><button id="rr-link">Update link</button>' +
      '<div id="rr-linkbox" style="display:none"></div>' +
      '<p class="muted">Keep this page open and the reader awake while it works.</p></div>';

    const $ = (id) => container.querySelector("#" + id);
    const log = (m) => { const el = $("rr-log"); el.textContent += m + "\n"; el.scrollTop = el.scrollHeight; };
    const setStatus = (m) => { $("rr-status").textContent = m; };
    let busy = false;
    let stopRequested = false;

    // Options from the controls under the search box
    const imagesOn = () => $("rr-img").checked;
    try { $("rr-img").checked = localStorage.getItem("rr-images") !== "0"; } catch (e) { $("rr-img").checked = true; }
    $("rr-img").onchange = () => { try { localStorage.setItem("rr-images", imagesOn() ? "1" : "0"); } catch (e) { /* ignore */ } };
    function readRange() {
      const f = parseInt($("rr-from").value, 10), t = parseInt($("rr-to").value, 10);
      if (!f && !t) return null;
      return { from: f > 0 ? f : 1, to: t > 0 ? t : null };
    }
    const options = () => ({ range: readRange(), images: imagesOn() });
    const site = () => $("rr-src").value;
    try { const v = localStorage.getItem("rr-src"); if (v === "sh" || v === "ao") $("rr-src").value = v; } catch (e) { /* ignore */ }
    const showBrowse = () => { $("rr-browsebox").style.display = site() === "rr" ? "" : "none"; };
    $("rr-src").onchange = () => { showBrowse(); try { localStorage.setItem("rr-src", site()); } catch (e) { /* ignore */ } };
    showBrowse();

    async function job(fn) {
      if (busy) return log("Already working \u2014 wait or press Stop.");
      busy = true; stopRequested = false;
      let lock = null;
      try { lock = navigator.wakeLock ? await navigator.wakeLock.request("screen") : null; } catch (e) { /* optional */ }
      try { await fn(); }
      catch (e) { log("Error: " + e.message); setStatus("Failed \u2014 see log."); }
      finally {
        await deleteSd([TMP + "/page.html", TMP + "/cover.bin", TMP + "/img.bin", TMP]);
        if (lock) lock.release().catch(() => {});
        busy = false;
        renderLibrary();
      }
    }

    function card(f, inLib) {
      const d = document.createElement("div");
      d.className = "card";
      const coverUrl = f.coverUrl || (inLib && inLib.coverUrl) || "";
      const badge = inLib && inLib.newCount != null
        ? (inLib.newCount > 0 ? ' \u00B7 <span class="new">' + inLib.newCount + " new</span>" : " \u00B7 up to date") : "";
      d.innerHTML =
        (coverUrl && !/nocover/i.test(coverUrl)
          ? '<img class="cover" loading="lazy" referrerpolicy="no-referrer" alt="" src="' + esc(coverUrl) + '"/>' : "") +
        "<b>" + esc(f.title) + "</b>" + (f.author ? ' <span class="muted">by ' + esc(f.author) + "</span>" : "") +
        '<div class="muted">' + ({ sh: "Scribble Hub \u00B7 ", ao: "AO3 \u00B7 " }[f.source || (inLib && inLib.source)] || "") + esc(f.status || "UNKNOWN") +
        (f.chapters != null ? " \u00B7 " + f.chapters + " chapters" : "") +
        (f.pages ? " \u00B7 " + f.pages + " pages" : "") +
        (inLib && inLib.chapters != null ? " \u00B7 you have " + inLib.chapters + (inLib.online ? " of " + inLib.online : "") : "") +
        (inLib && inLib.range ? " \u00B7 range " + (inLib.range.from || 1) + "\u2013" + (inLib.range.to || "latest") : "") +
        badge + "</div>" +
        (f.genres && f.genres.length ? '<div class="tags">' + esc(f.genres.join(" \u00B7 ")) + "</div>" : "") +
        (f.blurb ? '<div class="blurb" title="Tap to expand">' + esc(f.blurb) + (f.blurb.length >= 400 ? "\u2026" : "") + "</div>" : "");
      const cv = d.querySelector("img.cover");
      if (cv) cv.onerror = () => cv.remove(); // no cover, or no internet on this phone
      const bl = d.querySelector(".blurb");
      if (bl) bl.onclick = () => bl.classList.toggle("open");
      const b = document.createElement("button");
      b.textContent = inLib ? "Update" : "Download";
      b.onclick = () => { showProgress(); job(() => sync(f.url, options())); };
      d.appendChild(b);
      if (inLib) {
        const r = document.createElement("button");
        r.textContent = "Re-download all";
        r.onclick = () => { if (confirm("Download every chapter again?")) job(() => sync(f.url, Object.assign(options(), { fresh: true }))); };
        d.appendChild(r);
      }
      return d;
    }

    async function renderLibrary() {
      const lib = await loadLibrary();
      const box = $("rr-lib");
      box.innerHTML = "";
      const ids = Object.keys(lib);
      if (!ids.length) { box.textContent = "Nothing downloaded yet."; return; }
      ids.sort((a, b) => lib[a].title.localeCompare(lib[b].title))
        .forEach((id) => box.appendChild(card(Object.assign({ id }, lib[id], { chapters: null }), lib[id])));
    }

    // ---- results (search or browse): 5 at a time, fetching the next Royal Road page when needed
    const PAGE = 5;
    let src = null, results = [], seen = new Set(), resultsLib = {}, shown = 0;
    const statusWanted = () => $("rr-st").value;

    async function startResults(pageUrl, label, parser) {
      const want = statusWanted();
      src = { pageUrl, parser: parser || parseSearch, page: 0, done: false, filter: (f) => !want || f.status === want };
      results = []; seen = new Set(); shown = 0;
      resultsLib = await loadLibrary();
      $("rr-res").innerHTML = "";
      $("rr-more").style.display = "none";
      setStatus(label + "\u2026");
      await fillResults();
      setStatus(results.length ? label + (want ? " (" + want.toLowerCase() + ")" : "")
        : "Nothing found" + (want ? " with that status" : "") + ".");
    }
    async function fillResults() {
      // Pages can be filtered down to few or no matches, so read up to 3 pages per tap.
      for (let reads = 0; results.length < shown + PAGE && !src.done && reads < 3 && !stopRequested; reads++) {
        src.page++;
        const list = src.parser(await fetchDoc(src.pageUrl(src.page)));
        const fresh = list.filter((f) => f.id && !seen.has(f.id));
        fresh.forEach((f) => seen.add(f.id));
        if (!fresh.length) src.done = true;
        results.push(...fresh.filter(src.filter));
      }
      const res = $("rr-res");
      results.slice(shown, shown + PAGE).forEach((f) => res.appendChild(card(f, resultsLib[f.id])));
      shown = Math.min(results.length, shown + PAGE);
      const more = $("rr-more");
      more.style.display = shown < results.length || !src.done ? "" : "none";
      more.textContent = shown < results.length ? "Show more (" + (results.length - shown) + " ready)" : "Show more";
    }
    $("rr-more").onclick = () => job(fillResults);

    $("rr-go").onclick = () => job(async () => {
      const q = $("rr-q").value.trim();
      if (!q) return;
      if (/scribblehub\.com\/(series|read)\//i.test(q)) {
        const lib = await loadLibrary();
        $("rr-res").innerHTML = "";
        $("rr-more").style.display = "none";
        let url = q.startsWith("http") ? q : "https://" + q.replace(/^\/+/, "");
        const rm = url.match(/\/read\/(\d+)-([^/]+)/); // a chapter link: go to its series
        if (rm) url = SH + "/series/" + rm[1] + "/" + rm[2] + "/";
        setStatus("Opening link\u2026");
        const f = await shPeek(url);
        $("rr-res").appendChild(card({ id: f.id, source: "sh", title: f.title, author: f.author, url: f.url, status: f.status,
          chapters: f.total, genres: f.genres, coverUrl: f.coverUrl, blurb: f.descriptionText.slice(0, 400) }, lib[f.id]));
        setStatus("");
        return;
      }
      if (/(archiveofourown\.org|ao3\.org)\/works\/\d+/i.test(q)) {
        const lib = await loadLibrary();
        $("rr-res").innerHTML = "";
        $("rr-more").style.display = "none";
        const url = aoWorkUrl(q);
        setStatus("Opening link\u2026");
        const wu = aoAdult(url);
        const doc = await fetchDoc(wu);
        aoCheckOpen(doc, wu);
        const f = aoMeta(doc, url);
        $("rr-res").appendChild(card({ id: f.id, source: "ao", title: f.title, author: f.author, url: f.url, status: f.status,
          chapters: f.total, genres: f.genres, blurb: f.descriptionText.slice(0, 400) }, lib[f.id]));
        setStatus("");
        return;
      }
      if (/royalroad\.com\/fiction\/\d+/.test(q)) {
        const lib = await loadLibrary();
        $("rr-res").innerHTML = "";
        $("rr-more").style.display = "none";
        const url = q.startsWith("http") ? q : "https://" + q.replace(/^\/+/, "");
        setStatus("Opening link\u2026");
        const f = parseFiction(await fetchDoc(url), url);
        $("rr-res").appendChild(card({ id: f.id, title: f.title, author: f.author, url: f.url, status: f.status,
          chapters: f.chapters.length, genres: f.genres, coverUrl: f.coverUrl, blurb: f.descriptionText.slice(0, 400) }, lib[f.id]));
        setStatus("");
        return;
      }
      if (site() === "ao") {
        const base = AO + "/works/search?work_search%5Bquery%5D=" + encodeURIComponent(q);
        await startResults((n) => base + (n > 1 ? "&page=" + n : ""), "AO3 results for \u201C" + q + "\u201D", aoParseSearch);
        return;
      }
      if (site() === "sh") {
        const qs = "?s=" + encodeURIComponent(q) + "&post_type=fictionposts";
        await startResults((n) => SH + (n > 1 ? "/page/" + n + "/" : "/") + qs, "Scribble Hub results for \u201C" + q + "\u201D", shParseSearch);
        return;
      }
      const base = RR + "/fictions/search?title=" + encodeURIComponent(q);
      await startResults((n) => base + (n > 1 ? "&page=" + n : ""), "Results for \u201C" + q + "\u201D");
    });
    $("rr-q").addEventListener("keydown", (e) => { if (e.key === "Enter") $("rr-go").click(); });

    $("rr-browse").onclick = () => job(async () => {
      const list = $("rr-list").value, genre = $("rr-genre").value;
      const base = RR + "/fictions/" + list + (genre ? "?genre=" + encodeURIComponent(genre) : "");
      const name = LISTS.find((l) => l[0] === list)[1] + (genre ? " \u00B7 " + GENRES.find((g) => g[0] === genre)[1] : "");
      await startResults((n) => base + (n > 1 ? (genre ? "&" : "?") + "page=" + n : ""), name);
    });

    // Bring the progress area into view when a download starts
    function showProgress() {
      try { $("rr-status").scrollIntoView({ behavior: "smooth", block: "start" }); } catch (e) { /* ignore */ }
    }

    // ---- check for new chapters without downloading anything
    function wantedChapters(all, range) {
      const from = range ? Math.max(1, range.from || 1) : 1;
      const to = range && range.to ? Math.min(range.to, all.length) : all.length;
      return all.slice(from - 1, Math.max(from - 1, to));
    }
    async function checkAll() {
      const lib = await loadLibrary();
      const ids = Object.keys(lib);
      if (!ids.length) return log("Nothing to check.");
      let total = 0, withNew = 0;
      for (const id of ids) {
        if (stopRequested) { log("Stopped."); break; }
        const e = lib[id];
        setStatus("Checking " + e.title + "\u2026");
        try {
          const have = Array.isArray(e.ids) ? new Set(e.ids) : null;
          let n, status, online;
          if (sourceOf(e.url) === "ao") {
            // The light chapter list only; a range end, if set, isn't applied here
            const list = aoKeepOneShotId((await aoChapterList(e.url)).list, e.url, have);
            n = have ? list.filter((c) => !have.has(c.id)).length : Math.max(0, list.length - (e.chapters || 0));
            status = e.status; online = list.length;
          } else if (sourceOf(e.url) === "sh") {
            // Series page only: newest chapters plus the total (a range end, if set, isn't applied here)
            const f = await shPeek(e.url);
            const fresh = have ? f.firstPage.filter((c) => !have.has(c.id)).length : 0;
            n = have && fresh < f.firstPage.length ? fresh : Math.max(fresh, (f.total || 0) - (e.chapters || 0));
            status = f.status; online = f.total;
          } else {
            const fic = parseFiction(await fetchDoc(e.url), e.url);
            const wanted = wantedChapters(fic.chapters, e.range);
            n = have ? wanted.filter((c) => !have.has(c.id)).length : Math.max(0, wanted.length - (e.chapters || 0));
            status = fic.status; online = fic.chapters.length;
          }
          Object.assign(e, { status, online, newCount: n, checked: nowIso() });
          total += n; if (n) withNew++;
          log(e.title + ": " + (n ? n + " new" : "up to date"));
        } catch (err) { log(e.title + ": " + err.message); }
        await sleep(SOURCES[sourceOf(e.url)].delay);
      }
      await saveLibrary(lib);
      setStatus("Check finished: " + total + " new chapter(s) in " + withNew + " novel(s).");
      return { total, withNew };
    }
    $("rr-check").onclick = () => showProgress() || job(checkAll);

    async function updateAll() {
      const lib = await loadLibrary();
      const ids = Object.keys(lib);
      if (!ids.length) return log("Nothing to update.");
      let total = 0;
      for (const id of ids) {
        if (stopRequested) break;
        const e = lib[id];
        // Just checked and nothing new: skip the extra page load
        if (e.newCount === 0 && e.checked && Date.now() - Date.parse(e.checked) < 10 * 60 * 1000) {
          log("\u2014 " + e.title + ": up to date (checked just now)");
          continue;
        }
        log("\u2014 " + e.title);
        try { total += (await sync(e.url, { images: imagesOn() })).added; }
        catch (err) { log("Error: " + err.message); }
      }
      setStatus("Update all finished: " + total + " new chapter(s).");
    }
    $("rr-all").onclick = () => showProgress() || job(updateAll);
    $("rr-stop").onclick = () => { if (busy) { stopRequested = true; log("Stopping\u2026"); } };

    // ---- one-tap links: open the page with #rr-update-all (or #rr-check-all) to start right away
    const linkFor = (hash) => location.origin + location.pathname + hash;
    $("rr-link").onclick = async () => {
      const box = $("rr-linkbox");
      if (box.style.display !== "none") { box.style.display = "none"; return; }
      const up = linkFor("#rr-update-all"), ck = linkFor("#rr-check-all");
      box.innerHTML = '<div class="muted">Bookmark one of these (or add it to your home screen). Opening it starts right away.</div>' +
        '<a href="' + esc(up) + '">Update all</a> \u00B7 <a href="' + esc(ck) + '">Check all</a>' +
        '<input id="rr-linktext" readonly value="' + esc(up) + '"/>';
      box.style.display = "";
      const input = $("rr-linktext");
      input.onclick = () => input.select();
      try { await navigator.clipboard.writeText(up); log("Update link copied."); }
      catch (e) { input.select(); } // clipboard needs https; the link is selected for copying instead
    };

    function runFromLink() {
      const h = location.hash;
      if (h !== "#rr-update-all" && h !== "#rr-check-all") return;
      try { history.replaceState(null, "", location.pathname + location.search); } catch (e) { /* ignore */ }
      showProgress();
      log(h === "#rr-update-all" ? "Started from your update link." : "Started from your check link.");
      job(h === "#rr-update-all" ? updateAll : checkAll);
    }
    window.addEventListener("hashchange", runFromLink); // link tapped while the page is already open
    renderLibrary().then(runFromLink);
  });
})();
