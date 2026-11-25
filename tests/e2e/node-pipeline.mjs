// End-to-end check of the extension's engine without Chrome:
// test server (Referer+cookie required) -> lib/engine.js -> files -> helper host.sh (merge/remux) -> ffprobe.
// Usage: node tests/e2e/node-pipeline.mjs   (exit code 0 = all cases passed)
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMaster, parseMedia, isMasterPlaylist } from '../../extension/lib/hls.js';
import { parseMpd } from '../../extension/lib/dash.js';
import { hlsOptions, hlsSubtitleOptions, dashOptions } from '../../extension/lib/plan.js';
import { loadMediaPlaylist, downloadHlsTrack, recordHlsLive, downloadDashRep, hlsTrackExt } from '../../extension/lib/engine.js';
import { mergeVttSegments, parseVtt, vttToSrt } from '../../extension/lib/subtitles.js';
import { encode, FrameDecoder } from '../../helper/lib/framing.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = 47820;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const OUT = join(homedir(), 'Library', 'Caches', 'media-saver-pipeline');
const FIX = join(ROOT, 'tests', 'fixtures', 'out');
const PROBE = join(ROOT, 'tests', 'e2e', 'probe-output.sh');
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

let referer = `${ORIGIN}/p/`;
const hdrs = (extra = {}) => ({ Referer: referer, Cookie: 'ms_auth=ok', ...extra });
const fetchText = async (url) => { const r = await fetch(url, { headers: hdrs() }); if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`); return r.text(); };
const fetchBytes = async (url, range) => {
  const h = range ? hdrs({ Range: `bytes=${range.offset}-${range.offset + range.length - 1}` }) : hdrs();
  const r = await fetch(url, { headers: h });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return new Uint8Array(await r.arrayBuffer());
};
const fileWriter = (path) => { writeFileSync(path, Buffer.alloc(0)); return async (chunk) => appendFileSync(path, chunk); };
const common = { fetchText, fetchBytes, concurrency: 4, retries: 3, retryDelayMs: 50 };

// ---- helper host over stdio (exactly what Chrome does)
function helper(op, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(join(ROOT, 'helper', 'host.sh'), ['chrome-extension://ljojagcmpjloafhjikdgpdfndbncfhdc/'], { env: {}, cwd: '/' });
    const dec = new FrameDecoder();
    p.stdout.on('data', (c) => {
      for (const m of dec.push(c)) {
        if (!m.ok) continue;
        if (m.value.type === 'result') { resolve(m.value); p.stdin.end(); }
        if (m.value.type === 'error') { reject(new Error(`${m.value.code} ${m.value.message}`)); p.stdin.end(); }
      }
    });
    p.on('error', reject);
    p.stdin.write(encode({ id: 'x1', op, ...args }));
  });
}

function probe(file, expect, dur, tol = '0.6') {
  try { return execFileSync('bash', [PROBE, file, expect, String(dur), tol], { encoding: 'utf8' }).trim(); } catch (e) { throw new Error((e.stdout || e.message).trim()); }
}

const results = [];
async function run(name, fn) {
  const t0 = Date.now();
  try { const detail = await fn(); results.push({ name, ok: true, detail, ms: Date.now() - t0 }); } catch (e) { results.push({ name, ok: false, detail: e.message, ms: Date.now() - t0 }); }
}

async function hlsVod(name, page, playlistPath, { expectAudioSeparate = false, compareWith = null, subs = false } = {}) {
  referer = `${ORIGIN}/p/${page}`;
  const url = `${ORIGIN}/media/${playlistPath}`;
  const text = await fetchText(url);
  let opt;
  let master = null;
  if (isMasterPlaylist(text)) {
    master = parseMaster(text, url);
    const p = parseMedia(await fetchText(master.variants[0].uri), master.variants[0].uri);
    opt = hlsOptions(master, p.totalDuration).find((o) => !o.audioOnly);
  } else {
    opt = { videoUri: url, audioUri: null };
  }
  const outs = [];
  for (const [role, uri] of [['video', opt.videoUri], ['audio', opt.audioUri]]) {
    if (!uri) continue;
    const { pl } = await loadMediaPlaylist(uri, fetchText);
    const ext = hlsTrackExt(pl, role);
    const path = join(OUT, `${name}.part-${role}.${ext}`);
    await downloadHlsTrack({ ...common, pl, role, write: fileWriter(path) });
    outs.push({ role, path });
  }
  const notes = [];
  if (compareWith) {
    const want = Buffer.concat(compareWith.map((f) => readFileSync(join(FIX, f))));
    const got = readFileSync(outs[0].path);
    if (!want.equals(got)) throw new Error(`bytes differ from ${compareWith[0]}.. (${got.length} vs ${want.length})`);
    notes.push(`byte-identical to ${compareWith.length} plaintext segments`);
  }
  if (expectAudioSeparate && outs.length !== 2) throw new Error('expected separate audio track');
  const final = join(OUT, `${name}.mp4`);
  const v = outs.find((o) => o.role === 'video');
  const a = outs.find((o) => o.role === 'audio');
  const res = a ? await helper('merge', { video: v.path, audio: a.path, output: final, deleteInputs: true })
    : await helper('remux', { input: v.path, output: final, deleteInput: true });
  notes.push(probe(res.output, 'av', 12));
  if (existsSync(v.path)) throw new Error('helper did not delete the intermediate file');
  if (subs && master) {
    for (const s of hlsSubtitleOptions(master)) {
      const { pl } = await loadMediaPlaylist(s.uri, fetchText);
      const texts = [];
      for (const seg of pl.segments) texts.push(await fetchText(seg.uri));
      const vtt = mergeVttSegments(texts);
      const n = parseVtt(vtt).cues.length;
      if (n !== 6) throw new Error(`${s.lang}: expected 6 unique cues, got ${n}`);
      writeFileSync(join(OUT, `${name}.${s.lang}.srt`), vttToSrt(vtt));
      notes.push(`${s.lang} subtitles: ${n} cues`);
    }
  }
  return notes.join(' | ');
}

async function dash(name, dir) {
  referer = `${ORIGIN}/p/${dir}`;
  const url = `${ORIGIN}/media/${dir}/manifest.mpd`;
  const mpd = parseMpd(await fetchText(url), url);
  const opt = dashOptions(mpd).find((o) => !o.audioOnly);
  const files = {};
  for (const [role, id, list] of [['video', opt.videoId, mpd.video], ['audio', opt.audioId, mpd.audio]]) {
    const rep = list.find((r) => r.id === id);
    const path = join(OUT, `${name}.part-${role}.${role === 'audio' ? 'm4a' : 'mp4'}`);
    await downloadDashRep({ ...common, rep, write: fileWriter(path) });
    files[role] = path;
  }
  const res = await helper('merge', { video: files.video, audio: files.audio, output: join(OUT, `${name}.mp4`), deleteInputs: true });
  return `${opt.label} | ${probe(res.output, 'av', 12)}`;
}

// ---------------------------------------------------------------- main
const server = spawn(process.execPath, [join(ROOT, 'tests', 'server', 'server.js')], { env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
try {
  for (let i = 0; i < 50; i += 1) {
    try { if ((await fetch(`${ORIGIN}/healthz`)).ok) break; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  await run('hls-ts 720p + subs', () => hlsVod('hls-ts', 'hls-ts', 'hls-ts/master.m3u8', { subs: true }));
  await run('hls-fmp4', () => hlsVod('hls-fmp4', 'hls-fmp4', 'hls-fmp4/master.m3u8'));
  await run('hls-aes (IV = sequence 5..10)', () => hlsVod('hls-aes', 'hls-aes', 'hls-aes/media.m3u8', { compareWith: [0, 1, 2, 3, 4, 5].map((i) => `hls-ts/720p/seg00${i}.ts`) }));
  await run('hls-aes explicit IV', () => hlsVod('hls-aes-iv', 'hls-aes-iv', 'hls-aes/media-iv.m3u8', { compareWith: [0, 1, 2, 3, 4, 5].map((i) => `hls-ts/720p/seg00${i}.ts`) }));
  await run('hls-altaudio (separate audio)', () => hlsVod('hls-altaudio', 'hls-altaudio', 'hls-altaudio/master.m3u8', { expectAudioSeparate: true }));
  await run('hls-byterange', () => hlsVod('hls-byterange', 'hls-byterange', 'hls-byterange/media.m3u8', { compareWith: ['hls-byterange/media.ts'] }));
  await run('dash-timeline', () => dash('dash-timeline', 'dash-timeline'));
  await run('dash-number', () => dash('dash-number', 'dash-number'));
  await run('dash-base (SegmentBase)', () => dash('dash-base', 'dash-base'));
  await run('drm detection', async () => {
    referer = `${ORIGIN}/p/drm-hls`;
    const h = parseMedia(await fetchText(`${ORIGIN}/media/drm/hls.m3u8`), `${ORIGIN}/media/drm/hls.m3u8`);
    referer = `${ORIGIN}/p/drm-dash`;
    const d = parseMpd(await fetchText(`${ORIGIN}/media/drm/dash.mpd`), `${ORIGIN}/media/drm/dash.mpd`);
    if (!h.drm || !d.drm) throw new Error(`drm flags hls=${h.drm} dash=${d.drm}`);
    return `hls: ${h.drmReason} | dash: ContentProtection`;
  });
  await run('live record ~7 s then stop', async () => {
    referer = `${ORIGIN}/p/live`;
    await fetch(`${ORIGIN}/__live/reset`);
    const uri = `${ORIGIN}/media/live/live.m3u8`;
    const path = join(OUT, 'live.part-video.ts');
    const t0 = Date.now();
    const r = await recordHlsLive({ ...common, uri, write: fileWriter(path), shouldStop: () => Date.now() - t0 > 7000 });
    const res = await helper('remux', { input: path, output: join(OUT, 'live.mp4'), deleteInput: true });
    return `${r.segments} segments, ${r.seconds}s, gaps=${r.gaps} | ${probe(res.output, 'av', r.seconds, '0.7')}`;
  });
  await run('5 back-to-back HLS saves (no quota)', async () => {
    const out = [];
    for (let i = 1; i <= 5; i += 1) out.push((await hlsVod(`repeat-${i}`, 'hls-ts', 'hls-ts/master.m3u8')).startsWith('OK') ? 'ok' : 'x');
    return out.join(',');
  });
  const log = await (await fetch(`${ORIGIN}/__log`)).json();
  const bad = (Array.isArray(log) ? log : log.entries || []).filter((e) => e.status >= 400);
  results.push({ name: 'server log: no 4xx/5xx', ok: bad.length === 0, detail: bad.length ? JSON.stringify(bad.slice(0, 3)) : 'all media requests authorised', ms: 0 });
} finally {
  server.kill();
}

let failed = 0;
for (const r of results) {
  if (!r.ok) failed += 1;
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(34)} ${String(r.ms).padStart(5)}ms  ${r.detail}`);
}
console.log(`\n${results.length - failed}/${results.length} passed · outputs in ${OUT}`);
process.exit(failed ? 1 : 0);
