// Drives helper/host.js over stdio with framed messages and checks the results
// with ffprobe. Run through tests/e2e/helper-smoke.sh, which makes the fixtures.
//   node helper-smoke-driver.js <host.js> <workDir under $HOME> <file outside $HOME> <ffprobe>
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encode, FrameDecoder } from '../../helper/lib/framing.js';

const [hostJs, work, outsideFile, ffprobe] = process.argv.slice(2);
if (!hostJs || !work || !outsideFile || !ffprobe) {
  console.error('usage: helper-smoke-driver.js <host.js> <workDir> <outsideFile> <ffprobe>');
  process.exit(2);
}

let failures = 0;
function check(cond, label, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? `  -- ${extra}` : ''}`);
  if (!cond) failures += 1;
}

function probe(file) {
  const r = spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration:stream=index,codec_type,codec_name:stream_tags=language', '-of', 'json', file], { encoding: 'utf8' });
  if (r.status !== 0) return { error: r.stderr };
  const j = JSON.parse(r.stdout);
  // mp4 tags untagged tracks "und"; treat that as no language for comparisons.
  const lang = (s) => (s.tags?.language && s.tags.language !== 'und' ? `(${s.tags.language})` : '');
  const streams = j.streams.map((s) => `${s.codec_type}:${s.codec_name}${lang(s)}`);
  return { duration: Number(j.format.duration), streams };
}

function evidence(file) {
  const p = probe(file);
  const line = p.error ? `ffprobe error ${p.error}` : `${path.basename(file)}: duration=${p.duration.toFixed(3)}s streams=[${p.streams.join(', ')}]`;
  console.log(`      ffprobe ${line}`);
  return p;
}

// ---- host connection ----
const host = spawn(process.execPath, [hostJs, 'chrome-extension://ljojagcmpjloafhjikdgpdfndbncfhdc/'], { cwd: '/', stdio: ['pipe', 'pipe', 'pipe'] });
const hostStderr = [];
host.stderr.on('data', (c) => hostStderr.push(String(c)));
const exited = new Promise((r) => host.on('exit', (code, signal) => r({ code, signal })));
const decoder = new FrameDecoder();
const pending = new Map();
const stray = [];
host.stdout.on('data', (chunk) => {
  for (const m of decoder.push(chunk)) {
    if (!m.ok) { stray.push(m); continue; }
    const msg = m.value;
    const entry = pending.get(msg.id);
    if (!entry) { stray.push(msg); continue; }
    if (msg.type === 'progress') entry.progress.push(msg);
    else { pending.delete(msg.id); entry.resolve({ final: msg, progress: entry.progress }); }
  }
});

let seq = 0;
function request(body) {
  const id = `t${(seq += 1)}`;
  return new Promise((resolve) => {
    pending.set(id, { resolve, progress: [] });
    host.stdin.write(encode({ id, ...body }));
  });
}
function raw(obj) {
  return new Promise((resolve) => {
    pending.set(obj.id ?? null, { resolve, progress: [] });
    host.stdin.write(encode(obj));
  });
}

const W = (name) => path.join(work, name);
const isErr = (r, code) => r.final.type === 'error' && r.final.code === code;
const near = (d, want) => Math.abs(d - want) <= 0.5;

// 1. hello
const hello = await request({ op: 'hello' });
check(hello.final.type === 'result' && typeof hello.final.ffmpegVersion === 'string' && hello.final.home === os.homedir() && hello.final.version === '1.0.0',
  'hello returns version, ffmpeg, ffmpegVersion, home', JSON.stringify(hello.final));

// 2. remux ts -> mp4, with progress
const r1 = await request({ op: 'remux', input: W('clip.ts'), durationSec: 4 });
check(r1.final.type === 'result' && r1.final.output === W('clip.mp4') && r1.final.size > 0, 'remux clip.ts -> clip.mp4', JSON.stringify(r1.final));
check(r1.progress.length > 0 && r1.progress.every((p) => typeof p.outTimeSec === 'number' && p.percent >= 0 && p.percent <= 100),
  'remux streamed progress with percent', JSON.stringify(r1.progress.at(-1)));
if (r1.final.type === 'result') {
  const p = evidence(r1.final.output);
  check(near(p.duration, 4) && p.streams.join() === 'video:h264,audio:aac', 'clip.mp4 has h264 + aac, ~4 s');
}
const firstStat = fs.statSync(W('clip.mp4'));

// 3. same input again -> "clip (1).mp4", first output untouched
const r2 = await request({ op: 'remux', input: W('clip.ts') });
check(r2.final.type === 'result' && r2.final.output === W('clip (1).mp4'), 'second remux of clip.ts -> "clip (1).mp4"', JSON.stringify(r2.final));
const againStat = fs.statSync(W('clip.mp4'));
check(againStat.size === firstStat.size && againStat.mtimeMs === firstStat.mtimeMs, 'clip.mp4 was not overwritten');

// 4. merge video + audio + 2 subtitles (2-letter langs) -> mv.mp4
const m1 = await request({ op: 'merge', video: W('mv.video.mp4'), audio: W('mv.audio.m4a'), subtitles: [{ path: W('en.vtt'), lang: 'en' }, { path: W('ko.srt'), lang: 'ko' }], durationSec: 4 });
check(m1.final.type === 'result' && m1.final.output === W('mv.mp4'), 'merge mv.video.mp4 + mv.audio.m4a + en.vtt + ko.srt -> mv.mp4', JSON.stringify(m1.final));
if (m1.final.type === 'result') {
  const p = evidence(m1.final.output);
  check(near(p.duration, 4) && p.streams.join() === 'video:h264,audio:aac,subtitle:mov_text(eng),subtitle:mov_text(kor)', 'mv.mp4 has h264, aac, mov_text eng + kor, ~4 s');
}

// 5. merge without audio: subtitles only, the video file's own audio is kept
const m2 = await request({ op: 'merge', video: W('clip.mp4'), subtitles: [{ path: W('en.vtt'), lang: 'en-US' }], output: 'subs-only.mp4' });
check(m2.final.type === 'result' && m2.final.output === W('subs-only.mp4'), 'merge subtitles-only with a bare output name', JSON.stringify(m2.final));
if (m2.final.type === 'result') {
  const p = evidence(m2.final.output);
  check(near(p.duration, 4) && p.streams.join() === 'video:h264,audio:aac,subtitle:mov_text(eng)', 'subs-only.mp4 keeps the source audio and adds mov_text eng');
}

// 6. merge into mkv: subtitles become srt
const m3 = await request({ op: 'merge', video: W('mv.video.mp4'), audio: W('mv.audio.m4a'), subtitles: [{ path: W('en.vtt'), lang: 'en' }], output: W('mv.mkv') });
check(m3.final.type === 'result' && m3.final.output === W('mv.mkv'), 'merge into .mkv', JSON.stringify(m3.final));
if (m3.final.type === 'result') {
  const p = evidence(m3.final.output);
  check(near(p.duration, 4) && p.streams.join() === 'video:h264,audio:aac,subtitle:subrip(eng)', 'mv.mkv has h264, aac, subrip eng');
}

// 7. audio-only remux .aac -> .m4a
const a1 = await request({ op: 'remux', input: W('tone.aac') });
check(a1.final.type === 'result' && a1.final.output === W('tone.m4a'), 'remux tone.aac -> tone.m4a', JSON.stringify(a1.final));
if (a1.final.type === 'result') {
  const p = evidence(a1.final.output);
  check(near(p.duration, 4) && p.streams.join() === 'audio:aac', 'tone.m4a is aac only, ~4 s');
}

// 8. path rules
const b1 = await request({ op: 'remux', input: '/tmp/x.ts' });
check(isErr(b1, 'BAD_PATH'), 'remux /tmp/x.ts (outside $HOME, absent) -> BAD_PATH', JSON.stringify(b1.final));
const b2 = await request({ op: 'remux', input: outsideFile });
check(isErr(b2, 'BAD_PATH'), `remux ${outsideFile} (outside $HOME, exists) -> BAD_PATH`, JSON.stringify(b2.final));
const b3 = await request({ op: 'remux', input: W('missing.ts') });
check(isErr(b3, 'NOT_FOUND'), 'remux missing file under $HOME -> NOT_FOUND', JSON.stringify(b3.final));
const b4 = await request({ op: 'remux', input: W('clip.ts'), output: path.join(path.dirname(work), 'elsewhere.mp4') });
check(isErr(b4, 'BAD_PATH'), 'remux output in another folder -> BAD_PATH', JSON.stringify(b4.final));
const b5 = await request({ op: 'remux', input: W('notes.txt') });
check(isErr(b5, 'BAD_PATH'), 'remux .txt -> BAD_PATH', JSON.stringify(b5.final));
const b6 = await request({ op: 'reveal', path: outsideFile });
check(isErr(b6, 'BAD_PATH'), 'reveal outside $HOME -> BAD_PATH', JSON.stringify(b6.final));
const b7 = await request({ op: 'reveal', path: W('missing.mp4') });
check(isErr(b7, 'NOT_FOUND'), 'reveal missing file -> NOT_FOUND', JSON.stringify(b7.final));

// 9. bad requests
const q1 = await request({ op: 'transcode' });
check(isErr(q1, 'BAD_REQUEST'), 'unknown op -> BAD_REQUEST');
const q2 = await raw({ id: null, op: 'hello' });
check(isErr(q2, 'BAD_REQUEST'), 'missing id -> BAD_REQUEST (id null)');
const q3 = await request({ op: 'merge', video: W('mv.video.mp4') });
check(isErr(q3, 'BAD_REQUEST'), 'merge with neither audio nor subtitles -> BAD_REQUEST');
const q4 = await request({ op: 'remux', input: W('clip.ts'), deleteInput: 'yes' });
check(isErr(q4, 'BAD_REQUEST'), 'deleteInput of wrong type -> BAD_REQUEST');

// 10. deleteInput: removed after success
const d1 = await request({ op: 'remux', input: W('del.ts'), deleteInput: true });
check(d1.final.type === 'result' && !fs.existsSync(W('del.ts')) && fs.existsSync(W('del.mp4')), 'deleteInput:true removes the input after success', JSON.stringify(d1.final));

// 11. failure: input kept, no partial output left
const f1 = await request({ op: 'remux', input: W('bad.ts'), deleteInput: true });
check(isErr(f1, 'FFMPEG_FAILED') && fs.existsSync(W('bad.ts')) && !fs.existsSync(W('bad.mp4')), 'failed remux -> FFMPEG_FAILED, input kept, no output left', `${f1.final.code}: ${String(f1.final.message).split('\n').at(-1)}`);

// 12. concurrent remuxes of one input on one connection get distinct names
const [c1, c2] = await Promise.all([request({ op: 'remux', input: W('clip2.ts') }), request({ op: 'remux', input: W('clip2.ts') })]);
const names = [c1.final.output, c2.final.output].sort();
check(c1.final.type === 'result' && c2.final.type === 'result' && names[0] === W('clip2 (1).mp4') && names[1] === W('clip2.mp4'), 'two concurrent remuxes -> clip2.mp4 and clip2 (1).mp4', names.join(' | '));

// 13. real reveal only on request (it opens a Finder window)
if (process.env.SMOKE_REVEAL === '1') {
  const rv = await request({ op: 'reveal', path: W('clip.mp4') });
  check(rv.final.type === 'result', 'reveal clip.mp4 -> {} (Finder window opened)', JSON.stringify(rv.final));
} else {
  console.log('SKIP  real reveal (set SMOKE_REVEAL=1; it opens Finder)');
}

// 14. end of input -> host exits cleanly
host.stdin.end();
const ex = await Promise.race([exited, new Promise((r) => setTimeout(() => r({ timeout: true }), 5000))]);
check(ex.code === 0 && !ex.signal, 'host exits with code 0 when stdin ends', JSON.stringify(ex));
check(stray.length === 0, 'no unmatched or undecodable frames on stdout', JSON.stringify(stray).slice(0, 300));
console.log(`host stderr lines: ${hostStderr.join('').split('\n').filter(Boolean).length}`);
console.log(failures === 0 ? 'SMOKE OK' : `SMOKE FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
