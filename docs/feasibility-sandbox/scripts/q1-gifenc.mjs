// [media-saver] Q1/Q4 — pure-JS GIF encoder (gifenc, MIT) as a proxy for in-browser encoding.
// Frames are decoded by ffmpeg (in a browser they would come from <video> + canvas, which is slower).
import fs from 'node:fs';
import path from 'node:path';
import gifenc from 'gifenc';
const { GIFEncoder, quantize, applyPalette } = gifenc;
import { FFMPEG, run } from './convert-lib.mjs';

const S = path.resolve(import.meta.dirname, '..');
const [W, H, FPS] = [480, 270, 15];
const r = await run(FFMPEG, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-i', path.join(S, 'fixtures/clip720.mp4'),
  '-vf', `fps=${FPS},scale=${W}:${H}:flags=lanczos`, '-pix_fmt', 'rgba', '-f', 'rawvideo', path.join(S, 'out/_frames.rgba')]);
if (r.code !== 0) throw new Error(r.stderr);
const raw = fs.readFileSync(path.join(S, 'out/_frames.rgba'));
fs.unlinkSync(path.join(S, 'out/_frames.rgba'));
const frameBytes = W * H * 4;
const n = raw.length / frameBytes;

const t0 = performance.now();
const gif = GIFEncoder();
let peak = 0;
for (let i = 0; i < n; i++) {
  // own copy per frame: gifenc views rgba.buffer as Uint32Array, a shared view would scan every frame
  const rgba = new Uint8Array(raw.subarray(i * frameBytes, (i + 1) * frameBytes));
  const palette = quantize(rgba, 256);                 // per-frame palette, no dithering (gifenc has none)
  const index = applyPalette(rgba, palette);
  gif.writeFrame(index, W, H, { palette, delay: Math.round(1000 / FPS) });
  peak = Math.max(peak, process.memoryUsage().rss);
}
gif.finish();
const ms = Math.round(performance.now() - t0);
const out = path.join(S, 'out/A-gifenc-js-15fps-480.gif');
fs.writeFileSync(out, gif.bytes());
const ss = await run(FFMPEG, ['-hide_banner', '-nostdin', '-i', out, '-i', path.join(S, 'fixtures/clip720.mp4'), '-filter_complex',
  `[1:v]fps=${FPS},scale=${W}:${H}:flags=lanczos,format=rgb24[r];[0:v]format=rgb24[g];[g][r]ssim=shortest=1`, '-f', 'null', '-']);
const res = { name: 'A-gifenc-js-15fps-480', frames: n, encodeMs: ms, sizeKB: Math.round(fs.statSync(out).size / 1024),
  peakRssMB: Math.round(peak / 1048576), rawFramesMB: Math.round(raw.length / 1048576),
  ssim: Number((ss.stderr.match(/All:([\d.]+)/) || [])[1]) };
console.log(JSON.stringify(res));
fs.writeFileSync(path.join(S, 'evidence/q1-gifenc.json'), JSON.stringify(res, null, 2));
