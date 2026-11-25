/**
 * Media Saver service worker.
 * - Detects media responses per tab (webRequest) and probes HLS/DASH manifests.
 * - Replays the page's Referer/Origin for its own fetches via DNR session rules.
 * - Owns the job list; the offscreen document does the heavy segment work.
 * - Talks to the local ffmpeg helper (native messaging) to remux/merge.
 * No download quotas, no timers between downloads.
 */
import { classify, mediaExt } from './lib/detect.js';
import { parseMaster, parseMedia, isMasterPlaylist } from './lib/hls.js';
import { parseMpd } from './lib/dash.js';
import { hlsOptions, hlsSubtitleOptions, dashOptions, dashSubtitleOptions } from './lib/plan.js';
import { buildFilename, downloadPath, sanitize } from './lib/naming.js';
import { loadSettings } from './lib/settings.js';
import { runPool } from './lib/ordered.js';
import { scanPage } from './lib/scan.js';

const HOST = 'com.mediasaver.helper';
const TYPES = ['main_frame', 'sub_frame', 'media', 'xmlhttprequest', 'object', 'other'];
const ICON_ON = { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png', 48: 'icons/icon-48.png' };
const ICON_OFF = { 16: 'icons/icon-gray-16.png', 32: 'icons/icon-gray-32.png', 48: 'icons/icon-gray-48.png' };
const ACTIVE = new Set(['queued', 'downloading', 'recording', 'saving', 'processing']);

// ---------------------------------------------------------------- state
let state = { tabs: {}, jobs: {}, nextRuleId: 1000, nextJob: 1 };
const ready = (async () => {
  const s = await chrome.storage.session.get('state');
  if (s.state) state = { ...state, ...s.state };
  // jobs that were running when the browser/worker died cannot resume
  const hasOffscreen = await chrome.offscreen.hasDocument().catch(() => false);
  for (const j of Object.values(state.jobs)) {
    if (ACTIVE.has(j.status) && !hasOffscreen && j.kind !== 'video' && j.kind !== 'audio') {
      j.status = 'error'; j.error = '브라우저가 작업을 중단했습니다. 다시 받아 주십시오.';
    }
  }
  const live = new Set(Object.values(state.jobs).filter((j) => ACTIVE.has(j.status)).map((j) => j.ruleId));
  const rules = await chrome.declarativeNetRequest.getSessionRules();
  const stale = rules.map((r) => r.id).filter((id) => !live.has(id));
  if (stale.length) await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: stale });
})();

let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { chrome.storage.session.set({ state }).catch(() => {}); }, 250);
  broadcast();
}

const ports = new Set();
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'popup') return;
  ports.add(port);
  port.onDisconnect.addListener(() => ports.delete(port));
});
let bcTimer = null;
function broadcast() {
  if (bcTimer) return;
  bcTimer = setTimeout(() => {
    bcTimer = null;
    for (const p of ports) { try { p.postMessage({ type: 'changed' }); } catch { /* closed */ } }
  }, 200);
}

function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}

function tabEntry(tabId) {
  const k = String(tabId);
  if (!state.tabs[k]) state.tabs[k] = { items: {}, children: [], title: '', pageUrl: '' };
  return state.tabs[k];
}

function visibleItems(tabId) {
  const t = state.tabs[String(tabId)];
  if (!t) return [];
  // Manifests with a quality list first, then the highest (estimated) bitrate, then detection order.
  const rank = (i) => ((i.kind === 'hls' || i.kind === 'dash') && i.options.length > 1 ? 1 : 0);
  return Object.values(t.items).filter((i) => !i.hidden)
    .sort((a, b) => (rank(b) - rank(a)) || ((b.bitrate || 0) - (a.bitrate || 0)) || (a.detectedAt - b.detectedAt));
}

/** Bitrate (bits/s) of a media playlist, from the size of its first segment. */
async function estimateBitrate(media, headers, mimic = false) {
  const seg = media.segments.find((s) => s.duration > 0);
  if (!seg) return 0;
  let size = seg.byteRange ? seg.byteRange.length : 0;
  if (!size) {
    size = await withHeaders([seg.uri], headers, async () => {
      const r = await fetch(seg.uri, { credentials: 'include', cache: 'no-store', headers: { Range: 'bytes=0-0' } });
      const total = /\/(\d+)\s*$/.exec(r.headers.get('content-range') || '');
      const len = total ? Number(total[1]) : Number(r.headers.get('content-length') || 0);
      if (r.body) r.body.cancel().catch(() => {});
      return r.ok ? len : 0;
    }, mimic);
  }
  return size ? Math.round((size * 8) / seg.duration) : 0;
}

function updateBadge(tabId) {
  const n = visibleItems(tabId).length;
  chrome.action.setBadgeText({ tabId, text: n ? String(n) : '' }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#7c4dff' }).catch(() => {});
  chrome.action.setIcon({ tabId, path: n ? ICON_ON : ICON_OFF }).catch(() => {});
}

// ---------------------------------------------------------------- header replay (DNR)
async function allocRuleId() {
  state.nextRuleId += 1;
  if (state.nextRuleId > 4_000_000) state.nextRuleId = 1000;
  return state.nextRuleId;
}

function hostsOf(urls) {
  const out = new Set();
  for (const u of urls) { try { const h = new URL(u).hostname; if (h) out.add(h); } catch { /* data:, blob: */ } }
  return [...out];
}

/**
 * Install (or replace) a session rule that sets Referer/Origin on this extension's own
 * requests to `urls`' hosts. With `mimic`, it also copies what the page's own request
 * carried: Sec-Fetch-Site, the sec-ch-ua client hints, and no Origin when the page sent none.
 */
async function setHeaderRule(ruleId, urls, headers, mimic = false) {
  const requestHeaders = [];
  const h = headers || {};
  if (h.referer) requestHeaders.push({ header: 'referer', operation: 'set', value: h.referer });
  if (h.origin) requestHeaders.push({ header: 'origin', operation: 'set', value: h.origin });
  else if (mimic && h.captured) requestHeaders.push({ header: 'origin', operation: 'remove' });
  if (mimic) for (const [name, value] of Object.entries(h.extra || {})) if (value) requestHeaders.push({ header: name, operation: 'set', value });
  const domains = hostsOf(urls);
  if (!requestHeaders.length || !domains.length) return null;
  const id = ruleId || await allocRuleId();
  const install = (list) => chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [id],
    addRules: [{
      id,
      priority: mimic ? 2 : 1,
      action: { type: 'modifyHeaders', requestHeaders: list },
      condition: { requestDomains: domains, tabIds: [chrome.tabs.TAB_ID_NONE], resourceTypes: ['xmlhttprequest', 'media', 'other'] },
    }],
  });
  try {
    await install(requestHeaders);
  } catch (e) {
    // A header Chrome refuses to touch must not cost us the Referer/cookie replay.
    const basic = requestHeaders.filter((x) => x.header === 'referer' || x.header === 'origin');
    if (!basic.length || basic.length === requestHeaders.length) throw e;
    await install(basic);
  }
  return id;
}

async function removeRule(id) {
  if (id) await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [id] }).catch(() => {});
}

async function withHeaders(urls, headers, fn, mimic = false) {
  const id = await setHeaderRule(null, urls, headers, mimic);
  try { return await fn(); } finally { await removeRule(id); }
}

function httpError(status) {
  const e = new Error(`HTTP ${status}`);
  e.status = status;
  return e;
}

async function fetchText(url, headers, mimic = false) {
  return withHeaders([url], headers, async () => {
    const r = await fetch(url, { credentials: 'include', cache: 'no-store' });
    if (!r.ok) throw httpError(r.status);
    return r.text();
  }, mimic);
}

/**
 * Fetch from inside the page's own frame (content-script world): the request then carries
 * the page's origin, cookies and fetch metadata exactly. Text only (playlists).
 */
async function frameFetchText(tabId, frameId, url) {
  let res;
  try {
    [res] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId || 0] },
      world: 'ISOLATED',
      args: [url],
      func: async (u) => {
        try {
          const r = await fetch(u, { credentials: 'include', cache: 'no-store' });
          return { status: r.status, text: r.ok ? await r.text() : '' };
        } catch (e) { return { status: 0, error: String((e && e.message) || e) }; }
      },
    });
  } catch (e) {
    throw new Error(`페이지가 바뀌었거나 닫혔습니다(${e.message})`);
  }
  const v = res && res.result;
  if (!v) throw new Error('페이지에서 결과를 받지 못했습니다');
  if (v.status === 0) throw new Error(`요청 실패(${v.error})`);
  if (v.status < 200 || v.status >= 300) throw httpError(v.status);
  return v.text;
}

const ACCESS_LABEL = { basic: '확장 요청', mimic: '페이지 헤더 흉내', frame: '페이지 안 요청' };
const REFUSED = new Set([401, 403]);

/**
 * Read a playlist for an item, climbing basic -> mimic -> frame only while the host
 * answers 401/403. The rung that worked is kept on the item (and passed to jobs);
 * when every rung is refused the error lists each result, which tells the cases apart:
 * header check, page-only access, or a URL that cannot be fetched twice.
 */
async function itemText(item, url) {
  const ladder = ['basic', 'mimic', 'frame'];
  const tried = [];
  for (const how of ladder.slice(ladder.indexOf(item.access || 'basic'))) {
    try {
      const text = how === 'frame' ? await frameFetchText(item.tabId, item.frameId, url) : await fetchText(url, item.headers, how === 'mimic');
      if (item.access !== how) item.access = how;
      if (tried.length) item.accessTrail = [...tried, `${ACCESS_LABEL[how]} 성공`].join(' · ');
      return text;
    } catch (e) {
      tried.push(`${ACCESS_LABEL[how]} ${e.status || e.message}`);
      if (!REFUSED.has(e.status)) break;
    }
  }
  const all403 = tried.length === ladder.length && tried.every((x) => /\b40[13]$/.test(x));
  throw new Error(`${tried.join(' · ')}${all403 ? ' — 페이지 안에서도 거절되어, 한 번만 쓸 수 있거나 이미 만료된 주소로 보입니다. 페이지를 새로 고친 뒤 바로 저장해 보십시오.' : ''}`);
}

// ---------------------------------------------------------------- detection
const reqHeaders = new Map();

const MIMIC_HEADERS = ['sec-fetch-site', 'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform'];

chrome.webRequest.onSendHeaders.addListener((d) => {
  if (d.tabId < 0) return;
  // captured: true means "this is what the page really sent" (an empty origin then means none).
  const v = { referer: '', origin: '', captured: true, extra: {} };
  for (const h of d.requestHeaders || []) {
    const n = h.name.toLowerCase();
    if (n === 'referer') v.referer = h.value;
    else if (n === 'origin') v.origin = h.value;
    else if (MIMIC_HEADERS.includes(n)) v.extra[n] = h.value;
  }
  reqHeaders.set(d.requestId, v);
  if (reqHeaders.size > 3000) reqHeaders.delete(reqHeaders.keys().next().value);
}, { urls: ['<all_urls>'], types: TYPES }, ['requestHeaders', 'extraHeaders']);

chrome.webRequest.onBeforeRequest.addListener((d) => {
  if (d.type !== 'main_frame' || d.tabId < 0) return;
  ready.then(() => {
    delete state.tabs[String(d.tabId)];
    tabEntry(d.tabId).pageUrl = d.url;
    updateBadge(d.tabId);
    persist();
  });
}, { urls: ['<all_urls>'], types: ['main_frame'] });

chrome.webRequest.onHeadersReceived.addListener((d) => {
  if (d.tabId < 0 || d.statusCode >= 400) return;
  if (d.initiator && d.initiator.startsWith('chrome-extension://')) return;
  const h = {};
  for (const x of d.responseHeaders || []) h[x.name.toLowerCase()] = x.value;
  let len = h['content-length'] !== undefined ? Number(h['content-length']) : undefined;
  const cr = /\/(\d+)\s*$/.exec(h['content-range'] || '');
  if (cr) len = Number(cr[1]);
  const headers = reqHeaders.get(d.requestId) || { referer: d.documentUrl || d.initiator || '', origin: '' };
  ready.then(() => onMediaResponse(d, h['content-type'] || '', len, headers));
}, { urls: ['<all_urls>'], types: TYPES }, ['responseHeaders']);

chrome.webRequest.onCompleted.addListener((d) => reqHeaders.delete(d.requestId), { urls: ['<all_urls>'], types: TYPES });
chrome.webRequest.onErrorOccurred.addListener((d) => reqHeaders.delete(d.requestId), { urls: ['<all_urls>'], types: TYPES });

chrome.tabs.onRemoved.addListener((tabId) => { ready.then(() => { delete state.tabs[String(tabId)]; persist(); }); });
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.title) ready.then(() => { const t = state.tabs[String(tabId)]; if (t) { t.title = info.title; persist(); } });
  if (info.status === 'complete') ready.then(() => updateBadge(tabId));
  if (tab && tab.url && !state.tabs[String(tabId)]) { /* nothing detected yet */ }
});

async function onMediaResponse(d, contentType, contentLength, headers) {
  const settings = await loadSettings();
  const c = classify({ url: d.url, contentType, contentLength }, { minMediaBytes: settings.minMediaKB * 1024 });
  if (!['hls', 'dash', 'video', 'audio'].includes(c.kind)) return;
  addItem(d.tabId, {
    url: d.url, kind: c.kind, contentType: c.mime, size: contentLength || 0, ext: c.ext, headers,
    frameUrl: d.documentUrl || '', frameId: d.frameId || 0,
  });
}

function addItem(tabId, info) {
  const t = tabEntry(tabId);
  const id = `m${hash(info.url)}`;
  if (t.items[id]) {
    if (info.size && !t.items[id].size) { t.items[id].size = info.size; persist(); }
    return;
  }
  const item = {
    id, tabId, url: info.url, kind: info.kind, contentType: info.contentType || '', size: info.size || 0,
    ext: info.ext || '', headers: info.headers || { referer: '', origin: '' }, frameUrl: info.frameUrl || '', frameId: info.frameId || 0,
    access: 'basic', accessTrail: '',
    detectedAt: Date.now(), status: (info.kind === 'hls' || info.kind === 'dash') ? 'probing' : 'ready',
    options: [], subtitles: [], duration: info.duration || 0, live: false, drm: false, drmReason: null,
    note: '', error: null, hidden: t.children.includes(info.url), poster: info.poster || '',
  };
  if (info.kind === 'video' || info.kind === 'audio') {
    item.options = [{ id: 'f0', label: `${(mediaExt(info.kind, info.ext, info.contentType) || '').toUpperCase()} 원본`, audioOnly: info.kind === 'audio', estBytes: info.size || 0 }];
  }
  t.items[id] = item;
  updateBadge(tabId);
  persist();
  if (item.status === 'probing' && !item.hidden) probe(tabId, id);
}

function hideChildren(t, urls) {
  for (const u of urls) {
    if (!t.children.includes(u)) t.children.push(u);
    const child = t.items[`m${hash(u)}`];
    if (child) child.hidden = true;
  }
}

async function probe(tabId, id) {
  const t = tabEntry(tabId);
  const item = t.items[id];
  if (!item) return;
  try {
    const text = await itemText(item, item.url);
    if (item.kind === 'hls') {
      if (isMasterPlaylist(text)) {
        const master = parseMaster(text, item.url);
        hideChildren(t, [...master.variants.map((v) => v.uri), ...master.audio.map((a) => a.uri), ...master.subtitles.map((s) => s.uri)].filter(Boolean));
        let duration = 0; let live = false; let drm = master.drm; let drmReason = master.drmReason;
        const firstVideo = master.variants[0];
        if (firstVideo && !drm) {
          const media = parseMedia(await itemText(item, firstVideo.uri), firstVideo.uri);
          duration = media.totalDuration; live = media.live; if (media.drm) { drm = true; drmReason = media.drmReason; }
        }
        Object.assign(item, { options: hlsOptions(master, live ? 0 : duration), subtitles: hlsSubtitleOptions(master), duration, live, drm, drmReason });
      } else {
        const media = parseMedia(text, item.url);
        const audioOnly = media.segments.length > 0 && /\.(aac|mp3|ac3|ec3)(\?|$)/i.test(media.segments[0].uri);
        // No master playlist seen: the quality is unknown, so estimate the bitrate from the first segment.
        const bps = media.drm || item.access === 'frame' ? 0 : await estimateBitrate(media, item.headers, item.access === 'mimic').catch(() => 0);
        const rate = bps ? ` · 약 ${(bps / 1e6).toFixed(1)} Mbps` : '';
        Object.assign(item, {
          options: [{ id: 'v0', label: `${audioOnly ? '오디오' : '단일 화질'}${rate}`, height: 0, bandwidth: bps, videoUri: item.url, audioUri: null, audioOnly, estBytes: bps && !media.live ? Math.round((bps * media.totalDuration) / 8) : 0 }],
          subtitles: [], duration: media.totalDuration, live: media.live, drm: media.drm, drmReason: media.drmReason,
          bitrate: bps,
          note: audioOnly ? '' : '화질 목록(마스터 재생 목록)을 보지 못해 이 화질 하나만 보입니다. 더 높은 화질이 있다면 페이지를 새로 고친 뒤 재생하면 나타납니다.',
        });
      }
    } else {
      const mpd = parseMpd(text, item.url);
      Object.assign(item, {
        options: dashOptions(mpd), subtitles: dashSubtitleOptions(mpd), duration: mpd.duration, live: mpd.live, drm: mpd.drm,
        drmReason: mpd.drm ? 'ContentProtection' : null,
        note: mpd.live ? 'DASH 라이브 방송은 녹화할 수 없습니다(HLS 라이브만 지원).' : (mpd.periodCount > 1 ? `구간(Period) ${mpd.periodCount}개 중 첫 구간만 저장합니다.` : ''),
      });
    }
    item.status = item.drm ? 'drm' : 'ready';
    if (item.access !== 'basic') item.note = [item.note, `접근 방식: ${ACCESS_LABEL[item.access]} (${item.accessTrail})`].filter(Boolean).join(' ');
  } catch (e) {
    item.status = 'error';
    item.error = `목록을 읽지 못했습니다: ${e.message}`;
  }
  updateBadge(tabId);
  persist();
}

// ---------------------------------------------------------------- helper (native messaging)
let helperInfo = null; let helperAt = 0;
async function helperHello(force = false) {
  if (!force && helperAt && Date.now() - helperAt < 30_000) return helperInfo;
  try {
    const r = await chrome.runtime.sendNativeMessage(HOST, { id: `hello-${Date.now()}`, op: 'hello' });
    helperInfo = r && r.type === 'result' ? r : null;
  } catch { helperInfo = null; }
  helperAt = Date.now();
  return helperInfo;
}

function helperRun(op, args, onProgress) {
  return new Promise((resolve, reject) => {
    const id = `${op}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    let settled = false;
    const port = chrome.runtime.connectNative(HOST);
    port.onMessage.addListener((m) => {
      if (!m || m.id !== id) return;
      if (m.type === 'progress') { if (onProgress) onProgress(m); return; }
      settled = true;
      port.disconnect();
      if (m.type === 'result') resolve(m); else reject(new Error(`${m.code || 'ERROR'}: ${m.message || '도우미 오류'}`));
    });
    port.onDisconnect.addListener(() => {
      if (!settled) reject(new Error(chrome.runtime.lastError ? chrome.runtime.lastError.message : '도우미 연결이 끊겼습니다'));
    });
    port.postMessage({ id, op, ...args });
  });
}

// ---------------------------------------------------------------- offscreen
async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  try {
    await chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['BLOBS'], justification: 'Assemble downloaded media segments into files on disk' });
  } catch (e) {
    if (!/single offscreen/i.test(String(e && e.message))) throw e;
  }
}

function toOffscreen(msg) {
  return chrome.runtime.sendMessage({ target: 'offscreen', ...msg });
}

// ---------------------------------------------------------------- downloads bookkeeping
const waiters = new Map(); // downloadId -> {resolve, reject}

chrome.downloads.onChanged.addListener((delta) => {
  const w = waiters.get(delta.id);
  if (delta.state && w) {
    if (delta.state.current === 'complete') {
      waiters.delete(delta.id);
      chrome.downloads.search({ id: delta.id }).then(([it]) => w.resolve(it));
    } else if (delta.state.current === 'interrupted') {
      waiters.delete(delta.id);
      chrome.downloads.search({ id: delta.id }).then(([it]) => w.reject(new Error(`다운로드 중단: ${(it && it.error) || 'unknown'}`)));
    }
  }
  if (delta.state || delta.error) ready.then(() => onDirectChange(delta));
});

function waitDownload(id) {
  return new Promise((resolve, reject) => {
    waiters.set(id, { resolve, reject });
    chrome.downloads.search({ id }).then(([it]) => {
      if (!it || !waiters.has(id)) return;
      if (it.state === 'complete') { waiters.delete(id); resolve(it); } else if (it.state === 'interrupted') { waiters.delete(id); reject(new Error(`다운로드 중단: ${it.error}`)); }
    });
  });
}

function dirOf(p) { return p.slice(0, p.lastIndexOf('/')); }

// ---------------------------------------------------------------- jobs
function newJob(fields) {
  const id = `j${state.nextJob++}`;
  const job = {
    id, status: 'queued', progress: 0, bytes: 0, totalBytes: 0, segDone: 0, segTotal: 0, speed: 0, recordedSec: 0,
    startedAt: Date.now(), finishedAt: 0, outputs: [], files: [], error: null, note: '', ...fields,
  };
  state.jobs[id] = job;
  persist();
  return job;
}

async function finishJob(job, status, error) {
  job.status = status;
  job.error = error || null;
  job.finishedAt = Date.now();
  if (status === 'done') job.progress = 1;
  await removeRule(job.ruleId);
  job.ruleId = null;
  persist();
  if (status === 'done') await addHistory(job);
}

async function addHistory(job) {
  const settings = await loadSettings();
  if (!settings.history) return;
  const { history = [] } = await chrome.storage.local.get('history');
  history.unshift({ id: job.id, title: job.title, kind: job.kind, outputs: job.outputs, bytes: job.bytes, pageUrl: job.pageUrl, finishedAt: job.finishedAt });
  await chrome.storage.local.set({ history: history.slice(0, 200) });
}

async function startDownload({ tabId, itemId, optionId, subtitleIds = [] }) {
  await ready;
  const settings = await loadSettings();
  const t = tabEntry(tabId);
  const item = t.items[itemId];
  if (!item) throw new Error('항목을 찾지 못했습니다. 페이지를 새로 고쳐 주십시오.');
  if (item.drm) throw new Error('보호된(DRM) 콘텐츠라 저장할 수 없습니다.');
  const opt = item.options.find((o) => o.id === optionId) || item.options[0];
  if (!opt) throw new Error('저장할 화질을 고르지 못했습니다.');
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const pageUrl = (tab && tab.url) || t.pageUrl || item.frameUrl || item.url;
  let hostname = '';
  try { hostname = new URL(pageUrl).hostname; } catch { /* ignore */ }
  const quality = opt.audioOnly ? 'audio' : (opt.height ? `${opt.height}p` : '');
  const base = buildFilename({ template: settings.template, title: (tab && tab.title) || t.title || 'media', hostname, quality, ext: '', maxLength: settings.maxLength });
  const helper = settings.useHelper ? await helperHello() : null;
  const subtitles = item.subtitles.filter((s) => subtitleIds.includes(s.id));
  const job = newJob({
    itemId, tabId, title: base, base, kind: item.live ? 'live' : item.kind, live: item.live, url: item.url, pageUrl,
    headers: item.headers, option: opt, subtitles, folder: settings.folder, helper: Boolean(helper),
    estBytes: opt.estBytes || 0, durationSec: item.duration || 0,
    access: item.access || 'basic', mimic: (item.access || 'basic') !== 'basic', frameId: item.frameId || 0,
  });
  job.ruleUrls = [item.url, opt.videoUri, opt.audioUri, ...subtitles.map((s) => s.uri)].filter(Boolean);
  job.ruleId = await setHeaderRule(null, job.ruleUrls, item.headers, job.mimic);
  persist();

  if (item.kind === 'video' || item.kind === 'audio') {
    const ext = mediaExt(item.kind, item.ext, item.contentType);
    const downloadId = await chrome.downloads.download({ url: item.url, filename: downloadPath(settings.folder, `${base}.${ext}`), saveAs: false, conflictAction: 'uniquify' });
    job.downloadId = downloadId;
    job.status = 'downloading';
    persist();
    return job.id;
  }
  await ensureOffscreen();
  job.status = job.live ? 'recording' : 'downloading';
  persist();
  await toOffscreen({
    type: 'start',
    job: {
      id: job.id, kind: item.kind, live: item.live, url: item.url, base, option: opt, subtitles,
      helper: job.helper, concurrency: settings.concurrency, retries: settings.maxRetries,
      subtitleFormat: settings.subtitleFormat, access: job.access,
    },
  });
  return job.id;
}

async function onDirectChange(delta) {
  const job = Object.values(state.jobs).find((j) => j.downloadId === delta.id);
  if (!job || !(job.kind === 'video' || job.kind === 'audio')) return;
  if (delta.state && delta.state.current === 'complete') {
    const [it] = await chrome.downloads.search({ id: delta.id });
    job.outputs = [it.filename];
    job.bytes = it.fileSize || it.bytesReceived;
    job.files = [{ role: 'file', path: it.filename, downloadId: it.id }];
    await finishJob(job, 'done');
  } else if (delta.state && delta.state.current === 'interrupted') {
    await finishJob(job, delta.error && delta.error.current === 'USER_CANCELED' ? 'cancelled' : 'error', delta.error ? delta.error.current : '중단됨');
  }
}

async function refreshDirectProgress() {
  const active = Object.values(state.jobs).filter((j) => j.downloadId && ACTIVE.has(j.status));
  for (const j of active) {
    const [it] = await chrome.downloads.search({ id: j.downloadId });
    if (!it) continue;
    j.bytes = it.bytesReceived;
    j.totalBytes = it.totalBytes > 0 ? it.totalBytes : 0;
    j.progress = j.totalBytes ? j.bytes / j.totalBytes : 0;
    if (it.estimatedEndTime) j.note = '';
  }
}

async function finalizeJob(job) {
  const settings = await loadSettings();
  const video = job.files.find((f) => f.role === 'video');
  const audio = job.files.find((f) => f.role === 'audio');
  const subs = job.files.filter((f) => f.role === 'subtitle');
  const main = video || audio;
  if (!main) { await finishJob(job, 'error', '저장된 파일이 없습니다.'); return; }
  if (!job.helper) {
    job.outputs = job.files.map((f) => f.path);
    if (video && audio) job.note = '도우미가 없어 영상과 음성을 따로 저장했습니다.';
    await finishJob(job, 'done');
    return;
  }
  job.status = 'processing';
  job.progress = 0;
  persist();
  const audioOnly = Boolean(job.option && job.option.audioOnly) || (!video && audio);
  const output = `${dirOf(main.path)}/${job.base}.${audioOnly ? 'm4a' : 'mp4'}`;
  const embed = settings.embedSubtitles ? subs.filter((s) => /\.(srt|vtt)$/i.test(s.path)).map((s) => ({ path: s.path, lang: s.lang || 'und' })) : [];
  const onProgress = (m) => { if (typeof m.percent === 'number') job.progress = m.percent / 100; persist(); };
  try {
    let res;
    if (video && audio) {
      res = await helperRun('merge', { video: video.path, audio: audio.path, subtitles: embed, output, deleteInputs: !settings.keepIntermediate, durationSec: job.durationSec || undefined }, onProgress);
    } else if (video && embed.length) {
      res = await helperRun('merge', { video: video.path, subtitles: embed, output, deleteInputs: !settings.keepIntermediate, durationSec: job.durationSec || undefined }, onProgress);
    } else {
      res = await helperRun('remux', { input: main.path, output, deleteInput: !settings.keepIntermediate, durationSec: job.durationSec || undefined }, onProgress);
    }
    job.outputs = [res.output, ...subs.map((s) => s.path)];
    if (res.size) job.bytes = res.size;
    await finishJob(job, 'done');
  } catch (e) {
    job.outputs = job.files.map((f) => f.path);
    job.note = `ffmpeg 변환 실패로 원본 조각 파일을 남겼습니다: ${e.message}`;
    await finishJob(job, 'done');
  }
}

// ---------------------------------------------------------------- images
async function scanTab(tabId) {
  const results = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: scanPage }).catch((e) => { throw new Error(`이 페이지는 읽을 수 없습니다: ${e.message}`); });
  const images = new Map();
  let title = ''; let pageUrl = '';
  for (const r of results) {
    const v = r.result;
    if (!v) continue;
    if (r.frameId === 0) { title = v.title; pageUrl = v.pageUrl; }
    for (const im of v.images) {
      const prev = images.get(im.url);
      if (!prev) images.set(im.url, im); else { prev.w = Math.max(prev.w, im.w); prev.h = Math.max(prev.h, im.h); }
    }
    for (const m of v.media) {
      const c = classify({ url: m.url, contentType: '' });
      const kind = ['hls', 'dash', 'video', 'audio'].includes(c.kind) ? c.kind : m.kind;
      addItem(tabId, { url: m.url, kind, contentType: '', ext: c.ext, headers: { referer: v.pageUrl, origin: '' }, frameUrl: v.pageUrl, frameId: r.frameId, duration: m.duration, poster: m.poster });
    }
  }
  const t = tabEntry(tabId);
  if (title) t.title = title;
  if (pageUrl) t.pageUrl = t.pageUrl || pageUrl;
  persist();
  return { title, pageUrl, images: [...images.values()] };
}

function imageName(url, index, used) {
  let name = 'image'; let ext = 'jpg';
  if (url.startsWith('data:')) {
    const m = /^data:image\/([a-z0-9.+-]+)/i.exec(url);
    ext = m ? m[1].replace('jpeg', 'jpg').replace('svg+xml', 'svg') : 'png';
    name = `image-${index + 1}`;
  } else {
    try {
      const last = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
      const dot = last.lastIndexOf('.');
      if (dot > 0) { name = last.slice(0, dot); ext = last.slice(dot + 1).toLowerCase(); } else if (last) name = last;
    } catch { /* keep defaults */ }
    if (!/^(jpe?g|png|gif|webp|avif|bmp|svg|ico|tiff?)$/.test(ext)) ext = 'jpg';
  }
  let base = sanitize(name).slice(0, 80);
  let candidate = `${base}.${ext}`; let n = 1;
  while (used.has(candidate.toLowerCase())) { n += 1; candidate = `${base} (${n}).${ext}`; }
  used.add(candidate.toLowerCase());
  return candidate;
}

async function downloadImages({ tabId, urls }) {
  await ready;
  const settings = await loadSettings();
  const t = tabEntry(tabId);
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const pageUrl = (tab && tab.url) || t.pageUrl || '';
  let host = 'page';
  try { host = new URL(pageUrl).hostname.replace(/^www\./, ''); } catch { /* keep */ }
  const stamp = buildFilename({ template: '%date', ext: '' });
  const folder = `${settings.folder ? `${settings.folder}/` : ''}${sanitize(`${host} ${stamp}`)}`;
  const job = newJob({ kind: 'images', title: `이미지 ${urls.length}장 · ${host}`, base: host, pageUrl, segTotal: urls.length, status: 'downloading', folder });
  job.ruleId = await setHeaderRule(null, urls.filter((u) => /^https?:/.test(u)), { referer: pageUrl, origin: '' });
  const used = new Set();
  const names = urls.map((u, i) => imageName(u, i, used));
  const failures = [];
  await runPool(urls, 4, async (url, i) => {
    try {
      const id = await chrome.downloads.download({ url, filename: downloadPath(folder, names[i]), saveAs: false, conflictAction: 'uniquify' });
      const it = await waitDownload(id);
      job.outputs.push(it.filename);
      job.bytes += it.fileSize || 0;
    } catch (e) {
      failures.push(`${names[i]}: ${e.message}`);
    }
    job.segDone += 1;
    job.progress = job.segDone / job.segTotal;
    persist();
  }, { retries: 1 });
  if (failures.length) job.note = `${failures.length}장 실패 — ${failures.slice(0, 3).join('; ')}`;
  await finishJob(job, job.outputs.length ? 'done' : 'error', job.outputs.length ? null : '한 장도 저장하지 못했습니다.');
  return job.id;
}

// ---------------------------------------------------------------- messages
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'sw') return false;
  handle(msg, sender).then((r) => sendResponse({ ok: true, ...(r || {}) }), (e) => sendResponse({ ok: false, error: String(e && e.message ? e.message : e) }));
  return true;
});

async function handle(msg) {
  await ready;
  switch (msg.type) {
    case 'getState': {
      await refreshDirectProgress();
      const settings = await loadSettings();
      const { history = [] } = await chrome.storage.local.get('history');
      const t = state.tabs[String(msg.tabId)];
      return {
        items: visibleItems(msg.tabId),
        title: t ? t.title : '',
        jobs: Object.values(state.jobs).sort((a, b) => b.startedAt - a.startedAt),
        helper: helperInfo, helperChecked: Boolean(helperAt), settings, history: history.slice(0, 50),
      };
    }
    case 'helperCheck': return { helper: await helperHello(true) };
    case 'download': return { jobId: await startDownload(msg) };
    case 'scan': return scanTab(msg.tabId);
    case 'downloadImages': { const p = downloadImages(msg); p.catch(() => {}); return {}; }
    case 'stopJob': {
      const job = state.jobs[msg.jobId];
      if (!job) return {};
      if (job.downloadId && ACTIVE.has(job.status)) { await chrome.downloads.cancel(job.downloadId).catch(() => {}); return {}; }
      await toOffscreen({ type: job.live && msg.mode !== 'cancel' ? 'stop' : 'cancel', jobId: job.id }).catch(() => {});
      return {};
    }
    case 'removeJob': { delete state.jobs[msg.jobId]; persist(); return {}; }
    case 'clearFinished': {
      for (const [id, j] of Object.entries(state.jobs)) if (!ACTIVE.has(j.status)) delete state.jobs[id];
      persist();
      return {};
    }
    case 'clearHistory': await chrome.storage.local.set({ history: [] }); persist(); return {};
    case 'reveal': {
      if (msg.path && (await helperHello())) { await helperRun('reveal', { path: msg.path }); return {}; }
      if (msg.downloadId) { chrome.downloads.show(msg.downloadId); return {}; }
      chrome.downloads.showDefaultFolder();
      return {};
    }
    case 'openFolder': chrome.downloads.showDefaultFolder(); return {};
    // ----- from the offscreen document
    case 'hosts': {
      const job = state.jobs[msg.jobId];
      if (job) {
        job.ruleUrls = [...new Set([job.url, ...(job.ruleUrls || []), ...msg.urls])];
        job.ruleId = await setHeaderRule(job.ruleId, job.ruleUrls, job.headers, job.mimic);
      }
      return {};
    }
    case 'upgradeAccess': {
      // A segment or playlist was refused (401/403): switch the job's rule to mimic mode once.
      const job = state.jobs[msg.jobId];
      if (!job) throw new Error('job gone');
      if (!job.mimic) {
        job.mimic = true;
        if (job.access === 'basic') job.access = 'mimic';
        job.ruleId = await setHeaderRule(job.ruleId, job.ruleUrls || [job.url], job.headers, true);
        persist();
        return { upgraded: true };
      }
      return { upgraded: false };
    }
    case 'frameText': {
      const job = state.jobs[msg.jobId];
      if (!job) throw new Error('job gone');
      return { text: await frameFetchText(job.tabId, job.frameId, msg.url) };
    }
    case 'progress': {
      const job = state.jobs[msg.jobId];
      if (job && ACTIVE.has(job.status)) { Object.assign(job, msg.fields); persist(); }
      return {};
    }
    case 'fileReady': {
      // Start the save and answer at once. Writing a multi-GB file can outlast the
      // worker's idle timeout, so the offscreen document polls 'downloadStatus'
      // instead of holding this message open (state lives in chrome.downloads).
      const job = state.jobs[msg.jobId];
      if (!job) throw new Error('job gone');
      job.status = 'saving';
      persist();
      const id = await chrome.downloads.download({ url: msg.blobUrl, filename: downloadPath(job.folder, msg.name), saveAs: false, conflictAction: 'uniquify' });
      job.pending = { ...(job.pending || {}), [id]: { role: msg.role, lang: msg.lang || '' } };
      persist();
      return { downloadId: id };
    }
    case 'downloadStatus': {
      const job = state.jobs[msg.jobId];
      const [it] = await chrome.downloads.search({ id: msg.downloadId });
      if (!it) return { state: 'interrupted', error: '다운로드 항목이 사라졌습니다' };
      if (it.state === 'complete' && job && job.pending && job.pending[msg.downloadId]) {
        const p = job.pending[msg.downloadId];
        delete job.pending[msg.downloadId];
        if (!job.files.some((f) => f.downloadId === it.id)) job.files.push({ role: p.role, path: it.filename, downloadId: it.id, lang: p.lang });
        if (job.status === 'saving') job.status = job.live ? 'recording' : 'downloading';
        persist();
      }
      return { state: it.state, path: it.filename, error: it.error || null, bytes: it.bytesReceived };
    }
    case 'complete': {
      const job = state.jobs[msg.jobId];
      if (job) { if (msg.note) job.note = msg.note; await finalizeJob(job); }
      return {};
    }
    case 'failed': {
      const job = state.jobs[msg.jobId];
      if (job) await finishJob(job, msg.cancelled ? 'cancelled' : 'error', msg.error);
      return {};
    }
    default:
      throw new Error(`unknown message ${msg.type}`);
  }
}

chrome.runtime.onInstalled.addListener(() => { helperHello(true); });
chrome.runtime.onStartup.addListener(() => { helperHello(true); });

// ---------------------------------------------------------------- local test hook
// Lets the local test pages (http://127.0.0.1:*/) drive the extension for
// end-to-end tests. It is OFF unless the file extension/dev-token.txt exists
// and the caller sends its contents; commands only act on the caller's own tab.
async function devToken() {
  try {
    const r = await fetch(chrome.runtime.getURL('dev-token.txt'), { cache: 'no-store' });
    if (!r.ok) return null;
    const t = (await r.text()).trim();
    return t.length >= 16 ? t : null;
  } catch { return null; }
}

chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
  (async () => {
    const token = await devToken();
    let origin = '';
    try { origin = new URL(sender.url).origin; } catch { /* ignore */ }
    if (!token || !msg || msg.token !== token || !/^http:\/\/127\.0\.0\.1(:\d+)?$/.test(origin) || !sender.tab) {
      return { ok: false, error: 'test hook disabled' };
    }
    const tabId = sender.tab.id;
    switch (msg.type) {
      case 'getState': return { ok: true, ...(await handle({ type: 'getState', tabId })) };
      case 'scan': return { ok: true, ...(await handle({ type: 'scan', tabId })) };
      case 'helperCheck': return { ok: true, ...(await handle({ type: 'helperCheck' })) };
      case 'download': return { ok: true, ...(await handle({ type: 'download', tabId, itemId: msg.itemId, optionId: msg.optionId, subtitleIds: msg.subtitleIds || [] })) };
      case 'downloadImages': return { ok: true, ...(await handle({ type: 'downloadImages', tabId, urls: msg.urls || [] })) };
      case 'stopJob': {
        const job = state.jobs[msg.jobId];
        if (!job || job.tabId !== tabId) return { ok: false, error: 'not your job' };
        return { ok: true, ...(await handle({ type: 'stopJob', jobId: msg.jobId, mode: msg.mode })) };
      }
      case 'openPanel': {
        await chrome.tabs.create({ url: chrome.runtime.getURL(`popup.html?tab=${tabId}&panel=${encodeURIComponent(msg.panel || 'media')}`), active: true });
        return { ok: true };
      }
      case 'openPopup': {
        await chrome.action.openPopup({ windowId: sender.tab.windowId });
        return { ok: true };
      }
      case 'reload': {
        setTimeout(() => chrome.runtime.reload(), 150);
        return { ok: true };
      }
      default: return { ok: false, error: `unknown ${msg.type}` };
    }
  })().then(sendResponse, (e) => sendResponse({ ok: false, error: String(e && e.message ? e.message : e) }));
  return true;
});
