/**
 * Offscreen document: runs the segment engine (lib/engine.js) for HLS/DASH
 * jobs, writes each track in order to the Origin Private File System (so
 * multi-GB files never sit in memory) and hands each finished file to the
 * service worker as a blob URL for chrome.downloads.
 */
import { parseMpd } from './lib/dash.js';
import { mergeVttSegments, vttToSrt } from './lib/subtitles.js';
import { loadMediaPlaylist, hlsTrackExt, downloadHlsTrack, recordHlsLive, downloadDashRep } from './lib/engine.js';

const running = new Map(); // jobId -> {ac, stop}
const toSW = (m) => chrome.runtime.sendMessage({ target: 'sw', ...m });

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return false;
  if (msg.type === 'start') {
    runJob(msg.job);
    sendResponse({ ok: true });
  } else if (msg.type === 'stop' || msg.type === 'cancel') {
    const r = running.get(msg.jobId);
    if (r) { if (msg.type === 'stop') r.stop = true; else r.ac.abort(); }
    sendResponse({ ok: Boolean(r) });
  } else if (msg.type === 'ping') {
    sendResponse({ ok: true, jobs: [...running.keys()] });
  }
  return false;
});

// Temp files of a previous offscreen document belong to jobs that no longer exist.
const cleaned = (async () => {
  try { await (await navigator.storage.getDirectory()).removeEntry('jobs', { recursive: true }); } catch { /* nothing */ }
})();

// ---------------------------------------------------------------- IO
function shortUrl(u) { try { const x = new URL(u); return `${x.hostname}…${x.pathname.slice(-40)}`; } catch { return String(u).slice(0, 60); } }

const REFUSED = new Set([401, 403]);

/**
 * Fetchers for one job. When the host refuses (401/403), the service worker switches
 * the job's header rule to mimic the page's own request once, and the request is
 * retried. Playlists (text) that are still refused are read from inside the page.
 */
function makeIO(job) {
  let upgrade = null;
  const upgradeOnce = () => {
    if (!upgrade) upgrade = toSW({ type: 'upgradeAccess', jobId: job.id }).then((r) => Boolean(r && r.ok));
    return upgrade;
  };
  async function fetchOk(url, init = {}) {
    let r = await fetch(url, { credentials: 'include', cache: 'no-store', ...init });
    if (REFUSED.has(r.status) && (await upgradeOnce())) r = await fetch(url, { credentials: 'include', cache: 'no-store', ...init });
    if (!r.ok) {
      const e = new Error(`HTTP ${r.status} ${shortUrl(url)}`);
      e.status = r.status;
      throw e;
    }
    return r;
  }
  async function fetchText(url, signal) {
    if (job.access === 'frame') return frameText(url);
    try {
      return await (await fetchOk(url, { signal })).text();
    } catch (e) {
      if (!REFUSED.has(e.status)) throw e;
      return frameText(url);
    }
  }
  async function frameText(url) {
    const res = await toSW({ type: 'frameText', jobId: job.id, url });
    if (!res || !res.ok) throw new Error(`페이지 안 요청도 실패: ${(res && res.error) || 'unknown'} ${shortUrl(url)}`);
    return res.text;
  }
  async function fetchBytes(url, range, signal) {
    const headers = {};
    if (range) headers.Range = `bytes=${range.offset}-${range.offset + range.length - 1}`;
    let r;
    try {
      r = await fetchOk(url, { headers, signal });
    } catch (e) {
      if (REFUSED.has(e.status)) e.message += ' — 영상 조각이 확장 요청을 거절했습니다(페이지 헤더 흉내까지 시도함)';
      throw e;
    }
    const buf = new Uint8Array(await r.arrayBuffer());
    if (range && r.status === 200 && buf.length > range.length) return buf.subarray(range.offset, range.offset + range.length);
    return buf;
  }
  async function streamWhole(url, write, signal) {
    const r = await fetchOk(url, { signal });
    const reader = r.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      await write(value);
    }
  }
  return { fetchText, fetchBytes, streamWhole };
}

async function openTemp(name) {
  await cleaned;
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle('jobs', { create: true });
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable({ keepExistingData: false });
  let closed = false;
  return {
    async write(chunk) { await w.write(chunk); },
    async close() { if (!closed) { closed = true; await w.close(); } },
    file: () => fh.getFile(),
    async discard() {
      if (!closed) { closed = true; try { await w.abort(); } catch { /* ignore */ } }
      try { await dir.removeEntry(name); } catch { /* ignore */ }
    },
  };
}

/** Hand a finished temp file to the service worker, which saves it with chrome.downloads. */
async function deliver(jobId, tmp, role, name) {
  await tmp.close();
  const file = await tmp.file();
  if (!file.size) throw new Error(`${role} 트랙이 비어 있습니다`);
  // Without an explicit generic type Chrome may treat ".ts" as text and rename the
  // download to ".txt"; octet-stream keeps the extension we chose. slice() does not copy.
  const url = URL.createObjectURL(file.slice(0, file.size, 'application/octet-stream'));
  try {
    return await saveViaDownloads(jobId, url, role, name, '');
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function deliverText(jobId, text, name, lang, mime) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  try { await saveViaDownloads(jobId, url, 'subtitle', name, lang); } finally { URL.revokeObjectURL(url); }
}

/**
 * Ask the service worker to save a blob URL, then poll until Chrome finished
 * writing it. Polling (instead of one long-lived message) survives the worker
 * being restarted mid-save, and each poll keeps it awake.
 */
async function saveViaDownloads(jobId, blobUrl, role, name, lang) {
  const res = await toSW({ type: 'fileReady', jobId, role, blobUrl, name, lang });
  if (!res || !res.ok) throw new Error((res && res.error) || '파일 저장 실패');
  let misses = 0;
  while (true) {
    await new Promise((r) => setTimeout(r, 500));
    let st;
    try { st = await toSW({ type: 'downloadStatus', jobId, downloadId: res.downloadId }); misses = 0; } catch (e) {
      misses += 1;
      if (misses > 20) throw e;
      continue;
    }
    if (!st || !st.ok) throw new Error((st && st.error) || '저장 상태를 알 수 없습니다');
    if (st.state === 'complete') return st.path;
    if (st.state === 'interrupted') throw new Error(`저장 중단: ${st.error || 'unknown'}`);
  }
}

/** Run `fill(write)` into a temp file, then deliver it; the temp file is always removed. */
async function withTemp(job, role, ext, separate, fill) {
  const tmp = await openTemp(`${job.id}-${role}.${ext}`);
  try {
    const result = await fill((chunk) => tmp.write(chunk));
    await deliver(job.id, tmp, role, trackName(job, role, ext, separate));
    return result;
  } finally {
    await tmp.discard();
  }
}

function trackName(job, role, ext, separate) {
  if (job.helper) return `${job.base}.part-${role}.${ext}`;
  return separate ? `${job.base}.${role}.${ext}` : `${job.base}.${ext}`;
}

// ---------------------------------------------------------------- progress
function makeProgress(jobId) {
  const p = { segDone: 0, segTotal: 0, bytes: 0, recordedSec: 0, speed: 0 };
  let lastSent = 0; let lastBytes = 0; let lastT = performance.now();
  p.add = (bytes) => { p.bytes += bytes; p.segDone += 1; p.report(); };
  p.report = (force = false) => {
    const now = performance.now();
    if (!force && now - lastSent < 400) return;
    const dt = (now - lastT) / 1000;
    if (dt >= 1) { p.speed = Math.max(0, (p.bytes - lastBytes) / dt); lastBytes = p.bytes; lastT = now; }
    lastSent = now;
    const progress = p.segTotal ? Math.min(1, p.segDone / p.segTotal) : 0;
    toSW({ type: 'progress', jobId, fields: { segDone: p.segDone, segTotal: p.segTotal, bytes: p.bytes, speed: p.speed, recordedSec: p.recordedSec, progress } }).catch(() => {});
  };
  return p;
}

// ---------------------------------------------------------------- jobs
async function runJob(job) {
  const ctl = { ac: new AbortController(), stop: false };
  running.set(job.id, ctl);
  try {
    let note = '';
    if (job.kind === 'hls') note = await runHls(job, ctl);
    else if (job.kind === 'dash') note = await runDash(job, ctl);
    else throw new Error(`지원하지 않는 종류: ${job.kind}`);
    await toSW({ type: 'complete', jobId: job.id, note });
  } catch (e) {
    const cancelled = ctl.ac.signal.aborted;
    await toSW({ type: 'failed', jobId: job.id, cancelled, error: cancelled ? '취소됨' : String(e && e.message ? e.message : e) }).catch(() => {});
  } finally {
    running.delete(job.id);
  }
}

async function saveSubtitle(job, vtt, lang) {
  const l = (lang || 'und').replace(/[^a-z0-9-]/gi, '') || 'und';
  if (job.subtitleFormat === 'vtt' || job.subtitleFormat === 'both') await deliverText(job.id, vtt, `${job.base}.${l}.vtt`, l, 'text/vtt');
  if (job.subtitleFormat !== 'vtt') await deliverText(job.id, vttToSrt(vtt), `${job.base}.${l}.srt`, l, 'application/x-subrip');
}

async function runHls(job, ctl) {
  const signal = ctl.ac.signal;
  const { fetchText, fetchBytes } = makeIO(job);
  const opt = job.option;
  const tracks = [];
  if (opt.videoUri) tracks.push({ role: opt.audioOnly ? 'audio' : 'video', ...(await loadMediaPlaylist(opt.videoUri, fetchText, signal)) });
  if (opt.audioUri) tracks.push({ role: 'audio', ...(await loadMediaPlaylist(opt.audioUri, fetchText, signal)) });
  if (!tracks.length) throw new Error('받을 트랙이 없습니다');
  for (const t of tracks) if (t.pl.drm) throw new Error(`보호된(DRM) 콘텐츠라 저장할 수 없습니다 (${t.pl.drmReason})`);

  const urls = new Set();
  for (const t of tracks) {
    urls.add(t.uri);
    for (const s of t.pl.segments.slice(0, 50)) { urls.add(s.uri); if (s.key && s.key.uri) urls.add(s.key.uri); if (s.map) urls.add(s.map.uri); }
  }
  for (const s of job.subtitles) urls.add(s.uri);
  await toSW({ type: 'hosts', jobId: job.id, urls: [...urls] });

  const prog = makeProgress(job.id);
  const separate = tracks.length > 1;
  const common = { fetchText, fetchBytes, signal, concurrency: job.concurrency, retries: job.retries };

  if (job.live) {
    const res = await Promise.all(tracks.map((t) => withTemp(job, t.role, hlsTrackExt(t.pl, t.role), separate, (write) => recordHlsLive({
      ...common, uri: t.uri, pl: t.pl, write,
      shouldStop: () => ctl.stop,
      onSegment: (bytes, seconds) => { if (t.role === tracks[0].role) prog.recordedSec = seconds; prog.add(bytes); },
    }))));
    prog.report(true);
    const gaps = res.reduce((s, r) => s + r.gaps, 0);
    return gaps ? `녹화 중 빠진 구간이 ${gaps}곳 있습니다(네트워크 지연).` : '';
  }

  prog.segTotal = tracks.reduce((s, t) => s + t.pl.segments.length, 0);
  for (const t of tracks) {
    await withTemp(job, t.role, hlsTrackExt(t.pl, t.role), separate, (write) => downloadHlsTrack({ ...common, pl: t.pl, role: t.role, write, onSegment: prog.add }));
  }
  prog.report(true);
  for (const s of job.subtitles) {
    const { pl } = await loadMediaPlaylist(s.uri, fetchText, signal);
    const texts = [];
    for (const seg of pl.segments) texts.push(await fetchText(seg.uri, signal));
    await saveSubtitle(job, mergeVttSegments(texts), s.lang);
  }
  return '';
}

async function runDash(job, ctl) {
  const signal = ctl.ac.signal;
  const { fetchText, fetchBytes, streamWhole } = makeIO(job);
  const mpd = parseMpd(await fetchText(job.url, signal), job.url);
  if (mpd.drm) throw new Error('보호된(DRM) 콘텐츠라 저장할 수 없습니다 (ContentProtection)');
  if (mpd.live) throw new Error('DASH 라이브 방송은 지원하지 않습니다');
  const opt = job.option;
  const video = opt.videoId ? mpd.video.find((r) => r.id === opt.videoId) : null;
  const audio = opt.audioId ? mpd.audio.find((r) => r.id === opt.audioId) : null;
  if (!video && !audio) throw new Error('선택한 화질을 목록에서 찾지 못했습니다');
  const reps = [video && { rep: video, role: 'video' }, audio && { rep: audio, role: 'audio' }].filter(Boolean);
  const texts = job.subtitles.map((s) => mpd.text.find((t) => t.id === s.repId)).filter(Boolean);

  const urls = new Set([job.url]);
  for (const { rep } of reps) { if (rep.init) urls.add(rep.init.url); for (const s of rep.segments.slice(0, 50)) urls.add(s.url); }
  for (const t of texts) urls.add(t.segments[0].url);
  await toSW({ type: 'hosts', jobId: job.id, urls: [...urls] });

  const prog = makeProgress(job.id);
  prog.segTotal = reps.reduce((s, r) => s + (r.rep.single ? 1 : r.rep.segments.length), 0);
  const separate = reps.length > 1;
  for (const r of reps) {
    await withTemp(job, r.role, r.role === 'audio' ? 'm4a' : 'mp4', separate, (write) => downloadDashRep({
      rep: r.rep, fetchBytes, write, signal, concurrency: job.concurrency, retries: job.retries,
      streamWhole: async (url, w, sig) => streamWhole(url, async (chunk) => { await w(chunk); prog.bytes += chunk.byteLength; prog.report(); }, sig),
      onSegment: (bytes) => { prog.bytes += bytes; prog.segDone += 1; prog.report(); },
    }));
  }
  prog.report(true);
  for (const t of texts) await saveSubtitle(job, await fetchText(t.segments[0].url, signal), t.lang);
  return mpd.periodCount > 1 ? `구간 ${mpd.periodCount}개 중 첫 구간만 저장했습니다.` : '';
}
