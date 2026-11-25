// [media-saver] Q2 — key-frame extraction (every N s / scene change / seek loop) + image normalisation.
// Writes out/frames-*/ (JPEG) + a manifest.json per set, and evidence/q2-extract.json (timings).
import fs from 'node:fs';
import path from 'node:path';
import { FFMPEG, run, framesEveryArgs, framesSceneArgs, frameAtArgs, toJpegArgs, ptsTimes } from './convert-lib.mjs';

const S = path.resolve(import.meta.dirname, '..');
const F = (p) => path.join(S, 'fixtures', p);
const hms = (t) => new Date(t * 1000).toISOString().slice(11, 19);
const fresh = (d) => { fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true }); return d; };
const manifest = (dir, items) => fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(items, null, 1));
const listJpg = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith('.jpg')).sort().map((f) => path.join(dir, f));
const log = [];
const note = (o) => { log.push(o); console.log(JSON.stringify(o)); };

// (a) every 2 s, 12 s clip
{
  const d = fresh(path.join(S, 'out/frames-every2s'));
  const r = await run(FFMPEG, framesEveryArgs({ input: F('clip720.mp4'), outPattern: path.join(d, 'f%04d.jpg'), every: 2 }));
  const files = listJpg(d);
  manifest(d, files.map((f, i) => ({ jpegPath: f, caption: `clip720.mp4  ${hms(i * 2)}` })));
  note({ step: 'every2s clip720 (fps=1/2)', code: r.code, ms: r.ms, frames: files.length });
}
// (b) scene change on a clip with 5 hard cuts, and on testsrc2 (no cuts -> only frame 0)
for (const [src, tag] of [['scenes.mp4', 'scenes'], ['clip720.mp4', 'nocuts']]) {
  const d = fresh(path.join(S, `out/frames-scene-${tag}`));
  const r = await run(FFMPEG, framesSceneArgs({ input: F(src), outPattern: path.join(d, 's%04d.jpg'), threshold: 0.3 }));
  const ts = ptsTimes(r.stderr);
  const files = listJpg(d);
  manifest(d, files.map((f, i) => ({ jpegPath: f, caption: `${src}  ${hms(ts[i] ?? 0)}  (t=${(ts[i] ?? 0).toFixed(2)}s)` })));
  note({ step: `scene>0.3 ${src}`, code: r.code, ms: r.ms, frames: files.length, ptsTimes: ts });
}
// long video (10 min 720p, GOP 2 s): fps filter vs seek loop vs scene detection
{
  const d1 = fresh(path.join(S, 'out/frames-long-fps'));
  const r1 = await run(FFMPEG, framesEveryArgs({ input: F('long600.mp4'), outPattern: path.join(d1, 'f%04d.jpg'), every: 10 }));
  const files1 = listJpg(d1);
  manifest(d1, files1.map((f, i) => ({ jpegPath: f, caption: `long600.mp4  ${hms(i * 10)}` })));
  note({ step: 'long600 every 10 s via fps=1/10 (full decode)', code: r1.code, ms: r1.ms, frames: files1.length });

  const d2 = fresh(path.join(S, 'out/frames-long-seek'));
  const t0 = performance.now();
  let bad = 0;
  for (let t = 0, k = 1; t < 600; t += 10, k++) {
    const r = await run(FFMPEG, frameAtArgs({ input: F('long600.mp4'), output: path.join(d2, `f${String(k).padStart(4, '0')}.jpg`), t }));
    if (r.code !== 0) bad++;
  }
  note({ step: 'long600 every 10 s via 60x (-ss t -frames:v 1) sequential', ms: Math.round(performance.now() - t0), frames: listJpg(d2).length, failed: bad });
  manifest(d2, listJpg(d2).map((f, i) => ({ jpegPath: f, caption: `long600.mp4  ${hms(i * 10)}` })));

  for (const side of [0, 320]) {
    const d3 = fresh(path.join(S, `out/frames-long-scene-${side || 'full'}`));
    const r3 = await run(FFMPEG, framesSceneArgs({ input: F('long600.mp4'), outPattern: path.join(d3, 's%04d.jpg'),
      threshold: 0.3, analyseSide: side, maxFrames: 300 }));
    note({ step: `long600 scene>0.3 analyseSide=${side || 'full 720p'}`, code: r3.code, ms: r3.ms, frames: listJpg(d3).length });
  }
}
// images -> baseline JPEG (first frame, alpha flattened on white, max side 2000)
{
  const d = fresh(path.join(S, 'out/images-normalised'));
  const imgs = fs.readdirSync(F('img')).sort();
  const items = [];
  for (const f of imgs) {
    const out = path.join(d, f.replace(/\.[^.]+$/, '.jpg'));
    const r = await run(FFMPEG, toJpegArgs({ input: F(`img/${f}`), output: out }));
    note({ step: `normalise ${f}`, code: r.code, ms: r.ms, err: r.stderr.trim().split('\n')[0] || '' });
    if (r.code === 0) items.push({ jpegPath: out, caption: f });
  }
  manifest(d, items);
}
fs.writeFileSync(path.join(S, 'evidence/q2-extract.json'), JSON.stringify(log, null, 2));
