// [media-saver] Q1 — video -> GIF and images -> GIF. Writes out/*.gif and evidence/q1-gif.json
import fs from 'node:fs';
import path from 'node:path';
import { FFMPEG, FFPROBE, run, gifArgs, gifNaiveArgs, imagesToGifArgs } from './convert-lib.mjs';

const S = path.resolve(import.meta.dirname, '..');
const F = (p) => path.join(S, 'fixtures', p);
const O = (p) => path.join(S, 'out', p);

async function timed(args) {                       // wall time + peak RSS via /usr/bin/time -l
  const r = await run('/usr/bin/time', ['-l', FFMPEG, ...args]);
  const rss = Number((r.stderr.match(/(\d+)\s+maximum resident set size/) || [])[1] || 0);
  const err = r.stderr.split('\n').filter((l) => l && !/^\s+\d+\s+\D/.test(l) && !/real|user|sys/.test(l)).slice(0, 3).join(' | ');
  return { code: r.code, ms: r.ms, peakRssMB: Math.round(rss / 1048576), err };
}
async function probe(file) {
  const r = await run(FFPROBE, ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries',
    'stream=codec_name,width,height,nb_read_frames:format=duration,size', '-of', 'json', file]);
  const j = JSON.parse(r.stdout);
  const st = j.streams[0];
  return { codec: st.codec_name, w: st.width, h: st.height, frames: Number(st.nb_read_frames),
    durSec: Number(j.format.duration), sizeKB: Math.round(j.format.size / 1024) };
}
async function ssim(gif, src, fps, w, h, start) {   // GIF vs same-fps/same-size source (rgb24)
  const seek = start != null ? ['-ss', String(start)] : [];
  const r = await run(FFMPEG, ['-hide_banner', '-nostdin', '-i', gif, ...seek, '-i', src, '-filter_complex',
    `[1:v]fps=${fps},scale=${w}:${h}:flags=lanczos,format=rgb24[r];[0:v]format=rgb24[g];[g][r]ssim=shortest=1`, '-f', 'null', '-']);
  const m = r.stderr.match(/SSIM .* All:([\d.]+)/);
  return m ? Number(m[1]) : null;
}

const jobs = [
  ['A-12s-15fps-480', gifArgs({ input: F('clip720.mp4'), output: O('A-12s-15fps-480.gif'), fps: 15, maxSide: 480 }), 'clip720.mp4', 15],
  ['B-12s-10fps-320', gifArgs({ input: F('clip720.mp4'), output: O('B-12s-10fps-320.gif'), fps: 10, maxSide: 320 }), 'clip720.mp4', 10],
  ['C-12s-15fps-720', gifArgs({ input: F('clip720.mp4'), output: O('C-12s-15fps-720.gif'), fps: 15, maxSide: 720 }), 'clip720.mp4', 15],
  ['D-2to7s-12fps-480', gifArgs({ input: F('clip720.mp4'), output: O('D-2to7s-12fps-480.gif'), start: 2, end: 7, fps: 12, maxSide: 480 }), 'clip720.mp4', 12, 2],
  ['E-statsfull-15fps-480', gifArgs({ input: F('clip720.mp4'), output: O('E-statsfull-15fps-480.gif'), fps: 15, maxSide: 480, statsMode: 'full' }), 'clip720.mp4', 15],
  ['N-naive-nopalette-15fps-480', gifNaiveArgs({ input: F('clip720.mp4'), output: O('N-naive-nopalette-15fps-480.gif'), fps: 15, maxSide: 480 }), 'clip720.mp4', 15],
  ['S-scenes-12fps-480', gifArgs({ input: F('scenes.mp4'), output: O('S-scenes-12fps-480.gif'), fps: 12, maxSide: 480 }), 'scenes.mp4', 12],
  ['P-portrait-12fps-480', gifArgs({ input: F('portrait.mp4'), output: O('P-portrait-12fps-480.gif'), fps: 12, maxSide: 480 })],
  ['R-rotated-meta-12fps-480', gifArgs({ input: F('rotated.mp4'), output: O('R-rotated-meta-12fps-480.gif'), fps: 12, maxSide: 480 })],
  ['V-vp9webm-12fps-480', gifArgs({ input: F('vp9.webm'), output: O('V-vp9webm-12fps-480.gif'), fps: 12, maxSide: 480 })],
  ['W-av1webm-12fps-480', gifArgs({ input: F('av1.webm'), output: O('W-av1webm-12fps-480.gif'), fps: 12, maxSide: 480 })],
  ['H-hdr10-notonemap-12fps-480', gifArgs({ input: F('hdr10.mp4'), output: O('H-hdr10-notonemap-12fps-480.gif'), fps: 12, maxSide: 480 })],
  ['K-korean-name', gifArgs({ input: F('한글 영상 (테스트).mp4'), output: O('한글 영상 (테스트).gif'), start: 0, end: 3, fps: 12, maxSide: 480 })],
  ['I-images-slideshow-640x360', imagesToGifArgs({ inputs: fs.readdirSync(F('img')).sort().map((f) => F(`img/${f}`)),
    output: O('I-images-slideshow-640x360.gif'), seconds: 1.5, width: 640, height: 360 })],
];

const results = [];
for (const [name, args, src, fps, start] of jobs) {
  const out = args[args.length - 1];
  if (fs.existsSync(out)) fs.unlinkSync(out);
  const t = await timed(args);
  const row = { name, out: path.relative(S, out), ...t };
  if (t.code === 0) Object.assign(row, await probe(out));
  if (t.code === 0 && src) row.ssim = await ssim(out, F(src), fps, row.w, row.h, start);
  results.push(row);
  console.log(JSON.stringify(row));
}
fs.writeFileSync(path.join(S, 'evidence', 'q1-gif.json'), JSON.stringify(results, null, 2));
