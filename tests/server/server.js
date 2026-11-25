// Local test server for the Media Saver end-to-end tests. Node built-ins only.
//
//   node tests/server/server.js          (PORT=47801 to move it; it always binds 127.0.0.1)
//
// /p/...        test pages; each sets the ms_auth=ok cookie and makes the browser request its media
// /media/...    files from tests/fixtures/out/; 403 unless the Referer starts with
//               http://127.0.0.1:<port>/p/ AND the cookie ms_auth=ok is sent. Range requests supported.
// /media/live/live.m3u8   sliding-window live playlist (see LIVE below); seg-<n>.ts -> live/seg<n % 40>.ts
// /__log  GET last 200 /media/ requests as JSON     /__log/clear  POST clears them (and requests.log)
// /__live/reset[?seq=N]  restart the live clock (optionally so the window starts at sequence N)
// /__live/end            freeze the live window and append #EXT-X-ENDLIST from now on
// /healthz               "ok"

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT) || 47800;
const ORIGIN = `http://${HOST}:${PORT}`;
const PAGE_REFERER_PREFIX = `${ORIGIN}/p/`;
const AUTH_COOKIE = 'ms_auth=ok';
const MEDIA_ROOT = path.resolve(import.meta.dirname, '..', 'fixtures', 'out');
const LOG_FILE = path.join(import.meta.dirname, 'requests.log');
const LOG_KEEP = 200;

/** Live simulator settings: one new segment every SEGMENT_MS, a window of WINDOW segments. */
const LIVE = { SEGMENT_MS: 2000, TARGET: 2, WINDOW: 5, POOL: 40 };

const TYPES = {
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.mpd': 'application/dash+xml',
  '.ts': 'video/mp2t',
  '.m4s': 'video/iso.segment',
  '.mp4': 'video/mp4',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.vtt': 'text/vtt',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bin': 'application/octet-stream',
};

// ---- request log ---------------------------------------------------------------------------

const recent = [];
const onceUsed = new Set();
// PNG signature + IHDR-looking bytes + 0x47 decoys, as disguised TS segments carry.
const FAKE_PNG_HEAD = Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), Buffer.alloc(96, 0x47)]);
const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });

/** Records one /media/ request once its response has finished or was aborted. */
function logMedia(req, res, auth) {
  const startedAt = new Date().toISOString();
  res.on('close', () => {
    const entry = {
      time: startedAt,
      method: req.method,
      path: req.url,
      range: req.headers.range ?? null,
      status: res.statusCode,
      hasReferer: auth.hasReferer,
      hasCookie: auth.hasCookie,
      ua: (req.headers['user-agent'] || '').slice(0, 40),
      referer: req.headers.referer ?? null,
      origin: req.headers.origin ?? null,
      fetchSite: req.headers['sec-fetch-site'] ?? null,
      fetchMode: req.headers['sec-fetch-mode'] ?? null,
      fetchDest: req.headers['sec-fetch-dest'] ?? null,
      headerNames: Object.keys(req.headers).sort().join(','),
      aborted: !res.writableFinished,
    };
    recent.push(entry);
    if (recent.length > LOG_KEEP) recent.shift();
    logStream.write(JSON.stringify(entry) + '\n');
  });
}

function clearLog() {
  recent.length = 0;
  fs.truncateSync(LOG_FILE, 0); // the stream appends (O_APPEND), so it keeps writing at the new end
}

// ---- auth ----------------------------------------------------------------------------------

/** Both conditions the extension must replay: a /p/ page Referer and the page cookie. */
function authOf(req) {
  const hasReferer = (req.headers.referer || '').startsWith(PAGE_REFERER_PREFIX);
  const hasCookie = (req.headers.cookie || '').split(';').some((c) => c.trim() === AUTH_COOKIE);
  return { hasReferer, hasCookie };
}

// ---- static files with Range ---------------------------------------------------------------

/**
 * Parses a single "bytes=" range. Returns null to serve the whole file (no header, malformed,
 * multi-range or last < first), 'unsatisfiable' for a 416, or {start, end} inclusive.
 */
function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  if (m[1] === '') {
    const n = Number(m[2]);
    if (n === 0 || size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(m[1]);
  if (m[2] !== '' && Number(m[2]) < start) return null;
  if (start >= size) return 'unsatisfiable';
  const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  return { start, end };
}

let realRoot = null;

/** Maps a decoded path below /media/ to a file inside MEDIA_ROOT, or null if it escapes. */
async function resolveMedia(rel) {
  if (rel.includes('\0')) return null;
  const abs = path.resolve(MEDIA_ROOT, rel);
  if (!abs.startsWith(MEDIA_ROOT + path.sep)) return null;
  try {
    realRoot ??= await fs.promises.realpath(MEDIA_ROOT);
    const real = await fs.promises.realpath(abs);
    if (!real.startsWith(realRoot + path.sep)) return null; // symlink pointing outside
    return real;
  } catch {
    return abs; // does not exist; the stat below answers 404
  }
}

async function sendFile(req, res, file) {
  let st;
  try {
    st = await fs.promises.stat(file);
  } catch {
    return sendText(res, 404, 'not found\n');
  }
  if (!st.isFile()) return sendText(res, 404, 'not found\n');
  const size = st.size;
  const headers = {
    'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'Last-Modified': st.mtime.toUTCString(),
  };
  const range = parseRange(req.headers.range, size);
  if (range === 'unsatisfiable') {
    res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}`, 'Content-Length': 0 });
    return res.end();
  }
  let start = 0;
  let end = size - 1;
  let status = 200;
  if (range) {
    ({ start, end } = range);
    status = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  }
  headers['Content-Length'] = size === 0 ? 0 : end - start + 1;
  res.writeHead(status, headers);
  if (req.method === 'HEAD' || size === 0) return res.end();
  const stream = fs.createReadStream(file, { start, end });
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

function sendText(res, status, body, type = 'text/plain; charset=utf-8', extra = {}) {
  const buf = Buffer.from(body);
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': buf.length, 'Cache-Control': 'no-store', ...extra });
  res.end(res.req.method === 'HEAD' ? undefined : buf);
}

const sendJson = (res, status, value) => sendText(res, status, JSON.stringify(value, null, 1) + '\n', 'application/json');

// ---- live simulator ------------------------------------------------------------------------

const live = { startMs: Date.now(), endedMs: null };

/** Media sequence number of the first segment in the window. */
function liveFirstSeq() {
  const now = live.endedMs ?? Date.now();
  return Math.max(0, Math.floor((now - live.startMs) / LIVE.SEGMENT_MS));
}

/**
 * Sliding-window media playlist. Segment s is seg-<s>.ts (served from seg<s % 40>.ts); the pool
 * restarts its timestamps every 40 segments, so each multiple of 40 carries #EXT-X-DISCONTINUITY,
 * and EXT-X-DISCONTINUITY-SEQUENCE counts the tagged segments that have left the window.
 */
function livePlaylist() {
  const first = liveFirstSeq();
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${LIVE.TARGET}`, `#EXT-X-MEDIA-SEQUENCE:${first}`];
  const dseq = first === 0 ? 0 : Math.floor((first - 1) / LIVE.POOL);
  if (dseq > 0) lines.push(`#EXT-X-DISCONTINUITY-SEQUENCE:${dseq}`);
  for (let s = first; s < first + LIVE.WINDOW; s++) {
    if (s > 0 && s % LIVE.POOL === 0) lines.push('#EXT-X-DISCONTINUITY');
    lines.push(`#EXTINF:${(LIVE.SEGMENT_MS / 1000).toFixed(3)},`, `seg-${s}.ts`);
  }
  if (live.endedMs !== null) lines.push('#EXT-X-ENDLIST');
  return lines.join('\n') + '\n';
}

const liveState = () => ({ firstSequence: liveFirstSeq(), ended: live.endedMs !== null });

// ---- pages ---------------------------------------------------------------------------------

/** A 64x64 PNG (four coloured quadrants) built with zlib, for the inline data: image. */
function inlinePng() {
  const w = 64;
  const h = 64;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  const colours = [[230, 30, 140], [250, 200, 20], [20, 160, 230], [40, 180, 90]];
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const c = colours[(y < h / 2 ? 0 : 2) + (x < w / 2 ? 0 : 1)];
      c.forEach((v, i) => (raw[y * (w * 3 + 1) + 1 + x * 3 + i] = v));
    }
  }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
const INLINE_PNG = `data:image/png;base64,${inlinePng().toString('base64')}`;

// Page scripts run in the browser. They fetch with credentials so the cookie and Referer go out
// exactly as a player library would send them.
const PAGE_JS = `
const out = document.getElementById('log');
const note = (s) => { out.textContent += s + '\\n'; };
async function get(url) {
  const r = await fetch(url, { credentials: 'include' });
  note(r.status + ' ' + url);
  return r.ok ? r.text() : '';
}
/** Fetches an HLS playlist; for a master, also the first variant's media playlist. */
async function hls(path) {
  const url = new URL(path, location.href).href;
  const text = await get(url);
  if (!text.includes('#EXT-X-STREAM-INF')) return;
  const lines = text.split(/\\r?\\n/);
  const at = lines.findIndex((l) => l.startsWith('#EXT-X-STREAM-INF'));
  const uri = lines.slice(at + 1).find((l) => l.trim() && !l.startsWith('#'));
  if (uri) await get(new URL(uri.trim(), url).href);
}
async function dash(path) { await get(new URL(path, location.href).href); }
`;

const STYLE = `
body { font: 15px/1.5 system-ui, sans-serif; margin: 24px; color: #1b1b1b; background: #fafafa; }
code, pre { font: 13px ui-monospace, Menlo, monospace; }
pre#log { background: #fff; border: 1px solid #ddd; padding: 8px; min-height: 2em; }
img { max-width: 100%; height: auto; border: 1px solid #ccc; margin: 4px; vertical-align: top; }
.bg { width: 640px; max-width: 100%; height: 360px; background-size: cover; border: 1px solid #ccc; }
.spacer { height: 6000px; border-left: 4px dashed #bbb; padding-left: 8px; color: #777; }
`;

function page(title, body, script = '') {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${STYLE}</style>
</head>
<body>
<p><a href="/p/">All test pages</a></p>
<h1>${title}</h1>
${body}
<h2>Requests made by this page</h2>
<pre id="log"></pre>
<script>${PAGE_JS}
${script}</script>
</body>
</html>
`;
}

/** Pages that only fetch one manifest: [slug, title, kind, media path, description]. */
const MANIFEST_PAGES = [
  ['hls-ts', 'MS Test - HLS TS', 'hls', '/media/hls-ts/master.m3u8', 'Master playlist, 360p + 720p MPEG-TS variants, English and Korean WebVTT subtitles.'],
  ['hls-fmp4', 'MS Test - HLS fMP4', 'hls', '/media/hls-fmp4/master.m3u8', 'Master + one 720p variant, fMP4 segments with EXT-X-MAP init.mp4.'],
  ['hls-aes', 'MS Test - HLS AES-128', 'hls', '/media/hls-aes/media.m3u8', 'AES-128 media playlist without IV attribute (IV = media sequence number, first sequence 5).'],
  ['hls-aes-iv', 'MS Test - HLS AES-128 Explicit IV', 'hls', '/media/hls-aes/media-iv.m3u8', 'AES-128 media playlist with an explicit IV attribute.'],
  ['hls-altaudio', 'MS Test - HLS Alternate Audio', 'hls', '/media/hls-altaudio/master.m3u8', 'Video-only variant, audio from an EXT-X-MEDIA TYPE=AUDIO rendition.'],
  ['hls-byterange', 'MS Test - HLS Byterange', 'hls', '/media/hls-byterange/media.m3u8', 'Single media.ts addressed with EXT-X-BYTERANGE.'],
  ['dash-timeline', 'MS Test - DASH SegmentTimeline', 'dash', '/media/dash-timeline/manifest.mpd', 'SegmentTemplate + SegmentTimeline ($Time$), video 360p/720p + audio.'],
  ['dash-number', 'MS Test - DASH Number', 'dash', '/media/dash-number/manifest.mpd', 'SegmentTemplate $Number%05d$ with @duration, video 360p/720p + audio.'],
  ['dash-base', 'MS Test - DASH SegmentBase', 'dash', '/media/dash-base/manifest.mpd', 'On-demand MPD: SegmentBase with whole-file BaseURL (video.mp4, audio.m4a), indexRange to sidx.'],
  ['drm-hls', 'MS Test - DRM HLS', 'hls', '/media/drm/hls.m3u8', 'HLS SAMPLE-AES with a FairPlay (skd://) key. Must show as protected.'],
  ['drm-dash', 'MS Test - DRM DASH', 'dash', '/media/drm/dash.mpd', 'DASH with Widevine ContentProtection. Must show as protected.'],
  ['guard-site', 'MS Test - Guard Sec-Fetch-Site', 'hls', '/media/guard-site/hls-ts/master.m3u8', 'Playlists and segments: 403 unless Sec-Fetch-Site is same-origin or same-site (fetch-metadata check).'],
  ['disguise', 'MS Test - Disguised Segments', 'hls', '/media/disguise/hls-ts/master.m3u8', 'Every .ts segment starts with a fake PNG header (as some hosts do); players skip to the first TS packet.'],
  ['guard-ch', 'MS Test - Guard Client Hints', 'hls', '/media/guard-ch/hls-ts/master.m3u8', 'Playlists and segments: 403 without the sec-ch-ua client hint.'],
];

function manifestPage([, title, kind, media, about]) {
  return page(title, `<p>${about}</p>\n<p>Manifest: <code>${media}</code></p>`, `${kind}(${JSON.stringify(media)}).catch((e) => note('error ' + e));`);
}

function directPage() {
  return page(
    'MS Test - Direct MP4 + MP3',
    `<p>Plain files played by media elements.</p>
<video src="/media/direct/clip.mp4" controls muted playsinline preload="auto" width="640" height="360"></video>
<p><audio src="/media/direct/tone.mp3" controls preload="auto"></audio></p>`,
  );
}

function livePage() {
  return page(
    'MS Test - HLS Live',
    `<p>Sliding-window live playlist, re-fetched every 2 s like a player does.</p>
<p>Manifest: <code>/media/live/live.m3u8</code> &mdash; <span id="state">waiting</span></p>`,
    `const liveUrl = new URL('/media/live/live.m3u8', location.href).href;
async function poll() {
  const text = await get(liveUrl);
  const seq = (text.match(/#EXT-X-MEDIA-SEQUENCE:(\\d+)/) || [])[1];
  const ended = text.includes('#EXT-X-ENDLIST');
  document.getElementById('state').textContent = 'media sequence ' + seq + (ended ? ', ended' : ', live');
  if (!ended) setTimeout(poll, 2000);
}
poll().catch((e) => note('error ' + e));`,
  );
}

async function imagesPage() {
  let files = [];
  try {
    files = (await fs.promises.readdir(path.join(MEDIA_ROOT, 'images'))).filter((f) => !f.startsWith('.')).sort();
  } catch {
    /* fixtures not built; the page says so below */
  }
  const url = (f) => `/media/images/${encodeURIComponent(f)}`;
  const plain = files.filter((f) => !/^(srcset-|css-bg-|lazy-)/.test(f));
  const srcset1 = files.find((f) => f.startsWith('srcset-1x-'));
  const srcset2 = files.find((f) => f.startsWith('srcset-2x-'));
  const bg = files.find((f) => f.startsWith('css-bg-'));
  const lazy = files.find((f) => f.startsWith('lazy-'));
  const body = `<p>${files.length ? `${files.length} files from <code>out/images/</code> plus one inline <code>data:</code> PNG (64x64).` : '<strong>No images: run tests/fixtures/make.sh.</strong>'}</p>
<h2>Plain &lt;img&gt;</h2>
${plain.map((f) => `<img src="${url(f)}" alt="${f}" title="${f}">`).join('\n')}
<h2>srcset (the browser picks one by device pixel ratio)</h2>
${srcset1 && srcset2 ? `<img src="${url(srcset1)}" srcset="${url(srcset1)} 1x, ${url(srcset2)} 2x" alt="srcset" title="${srcset1} / ${srcset2}">` : ''}
<h2>CSS background-image</h2>
${bg ? `<div class="bg" style="background-image: url('${url(bg)}')" title="${bg}"></div>` : ''}
<h2>Inline data: PNG</h2>
<img src="${INLINE_PNG}" width="64" height="64" alt="inline data PNG" title="inline 64x64">
<h2>Lazy image below the fold</h2>
<div class="spacer">Scroll down: the lazy image loads only near the viewport.</div>
${lazy ? `<img src="${url(lazy)}" loading="lazy" width="1024" height="768" alt="${lazy}" title="${lazy}" id="lazy">` : ''}`;
  return page('MS Test - Images', body);
}

function indexPage() {
  const rows = [
    ['direct', 'MS Test - Direct MP4 + MP3'],
    ...MANIFEST_PAGES.slice(0, 9).map(([slug, title]) => [slug, title]),
    ['live', 'MS Test - HLS Live'],
    ['images', 'MS Test - Images'],
    ...MANIFEST_PAGES.slice(9).map(([slug, title]) => [slug, title]),
    ['once', 'MS Test - One-time Playlist'],
  ];
  const list = rows.map(([slug, title]) => `<li><a href="/p/${slug}">${title}</a> <code>/p/${slug}</code></li>`).join('\n');
  return page('MS Test - Index', `<ul>\n${list}\n</ul>`);
}

/** One-time playlist: each page load makes a fresh token; a second request for it gets 403. */
function oncePage() {
  return page(
    'MS Test - One-time Playlist',
    '<p>The master playlist URL carries a one-time token: the page uses it once, any later request is refused.</p>',
    "hls('/media/once/' + Math.random().toString(36).slice(2, 12) + '/hls-ts/master.m3u8').catch((e) => note('error ' + e));",
  );
}

async function renderPage(slug) {
  if (slug === '') return indexPage();
  if (slug === 'once') return oncePage();
  if (slug === 'direct') return directPage();
  if (slug === 'live') return livePage();
  if (slug === 'images') return imagesPage();
  const def = MANIFEST_PAGES.find(([s]) => s === slug);
  return def ? manifestPage(def) : null;
}

// ---- routing -------------------------------------------------------------------------------

async function handle(req, res) {
  let url;
  try {
    url = new URL(req.url, ORIGIN);
  } catch {
    return sendText(res, 400, 'bad url\n');
  }
  const p = url.pathname;

  if (p === '/healthz') return sendText(res, 200, 'ok');
  if (p === '/__log' && req.method === 'GET') return sendJson(res, 200, recent);
  if (p === '/__log/clear' && req.method === 'POST') {
    clearLog();
    return sendJson(res, 200, { cleared: true });
  }
  if (p === '/__live/reset') {
    const seq = Number(url.searchParams.get('seq') || 0);
    live.startMs = Date.now() - (Number.isFinite(seq) && seq > 0 ? seq : 0) * LIVE.SEGMENT_MS;
    live.endedMs = null;
    return sendJson(res, 200, liveState());
  }
  if (p === '/__live/end') {
    live.endedMs ??= Date.now();
    return sendJson(res, 200, liveState());
  }

  if (p === '/p') return sendText(res, 301, 'moved\n', 'text/plain', { Location: '/p/' });
  if (p.startsWith('/p/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'method not allowed\n');
    const html = await renderPage(p.slice(3).replace(/\/+$/, ''));
    if (html === null) return sendText(res, 404, 'no such test page\n');
    return sendText(res, 200, html, 'text/html; charset=utf-8', {
      'Set-Cookie': `${AUTH_COOKIE}; Path=/; SameSite=Lax; HttpOnly`,
    });
  }

  if (p.startsWith('/media/')) {
    const auth = authOf(req);
    logMedia(req, res, auth);
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'method not allowed\n');
    if (!auth.hasReferer || !auth.hasCookie) return sendText(res, 403, 'forbidden: needs a /p/ Referer and the ms_auth cookie\n');
    let rel;
    try {
      rel = decodeURIComponent(p.slice('/media/'.length));
    } catch {
      return sendText(res, 400, 'bad path\n');
    }
    // Access guards that mimic real hosts: fetch metadata, client hints, one-time tokens.
    const guard = /^(guard-site|guard-ch|once|disguise)\/(.+)$/.exec(rel);
    if (guard) {
      const [, kind, rest] = guard;
      rel = rest;
      if (kind === 'guard-site' && !['same-origin', 'same-site'].includes(req.headers['sec-fetch-site'])) return sendText(res, 403, 'forbidden: Sec-Fetch-Site\n');
      if (kind === 'guard-ch' && !req.headers['sec-ch-ua']) return sendText(res, 403, 'forbidden: no client hints\n');
      if (kind === 'once') {
        const m = /^([a-z0-9]+)\/(.+)$/.exec(rest);
        if (!m) return sendText(res, 400, 'bad path\n');
        rel = m[2];
        if (rel.endsWith('master.m3u8')) {
          if (onceUsed.has(m[1])) return sendText(res, 403, 'forbidden: token already used\n');
          onceUsed.add(m[1]);
        }
      }
    }
    if (guard && guard[1] === 'disguise' && rel.endsWith('.ts')) {
      const file = await resolveMedia(rel);
      if (!file) return sendText(res, 400, 'bad path\n');
      const body = Buffer.concat([FAKE_PNG_HEAD, await fs.promises.readFile(file)]);
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
      return res.end(body);
    }
    if (rel === 'live/live.m3u8') return sendText(res, 200, livePlaylist(), TYPES['.m3u8']);
    const seg = /^live\/seg-(\d+)\.ts$/.exec(rel);
    if (seg) rel = `live/seg${Number(seg[1]) % LIVE.POOL}.ts`;
    const file = await resolveMedia(rel);
    if (!file) return sendText(res, 400, 'bad path\n');
    return sendFile(req, res, file);
  }

  return sendText(res, 404, 'not found\n');
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error(e);
    if (!res.headersSent) sendText(res, 500, 'server error\n');
    else res.destroy();
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Media Saver test server: ${ORIGIN}/p/  (media root ${MEDIA_ROOT})`);
  if (!fs.existsSync(MEDIA_ROOT)) console.warn('warning: fixtures missing, run: bash tests/fixtures/make.sh');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close();
    logStream.end();
    process.exit(0);
  });
}
