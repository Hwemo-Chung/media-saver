// [media-saver] feasibility prototype — ffmpeg argument builders for GIF / frame extraction.
// Mirrors the helper rules: spawn(ffmpeg, argsArray, { shell:false }), -n (never overwrite).
import { spawn } from 'node:child_process';

export const FFMPEG = '/opt/homebrew/bin/ffmpeg';
export const FFPROBE = '/opt/homebrew/bin/ffprobe';

/** Run a binary with an argument array (no shell). Resolves { code, stdout, stderr, ms }. */
export function run(bin, args) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const p = spawn(bin, args, { shell: false });
    let stdout = '', stderr = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('close', (code) => resolve({ code, stdout, stderr, ms: Math.round(performance.now() - t0) }));
  });
}

const BASE = ['-hide_banner', '-nostdin', '-n', '-loglevel', 'error'];
/** "long side <= maxSide", keeps aspect for portrait and landscape alike. */
const fitBox = (maxSide) => `scale=w=${maxSide}:h=${maxSide}:force_original_aspect_ratio=decrease:flags=lanczos`;

/** Video -> GIF in one ffmpeg pass (split -> palettegen -> paletteuse). */
export function gifArgs({ input, output, start, end, fps = 12, maxSide = 480, colors = 256,
  dither = 'sierra2_4a', statsMode = 'diff' }) {
  const a = [...BASE];
  if (start != null) a.push('-ss', String(start));
  if (end != null) a.push('-to', String(end));
  a.push('-i', input);
  const use = `paletteuse=dither=${dither}` + (statsMode === 'diff' ? ':diff_mode=rectangle' : '');
  a.push('-filter_complex',
    `[0:v]fps=${fps},${fitBox(maxSide)},split[a][b];[a]palettegen=max_colors=${colors}:stats_mode=${statsMode}[p];[b][p]${use}`,
    '-an', '-loop', '0', output);
  return a;
}

/** Video -> GIF in two ffmpeg runs (palette PNG in a temp file). Same bytes as gifArgs, but memory
 *  stays flat: the one-pass graph queues every frame until palettegen emits at EOF (60 s @720: 1 GB). */
export function gifTwoPassArgs({ input, output, palettePath, start, end, fps = 12, maxSide = 480, colors = 256,
  dither = 'sierra2_4a', statsMode = 'diff' }) {
  const seek = [...(start != null ? ['-ss', String(start)] : []), ...(end != null ? ['-to', String(end)] : [])];
  const vf = `fps=${fps},${fitBox(maxSide)}`;
  const use = `paletteuse=dither=${dither}` + (statsMode === 'diff' ? ':diff_mode=rectangle' : '');
  return [
    [...BASE, ...seek, '-i', input, '-vf', `${vf},palettegen=max_colors=${colors}:stats_mode=${statsMode}`, '-update', '1', palettePath],
    [...BASE, ...seek, '-i', input, '-i', palettePath, '-filter_complex', `[0:v]${vf}[x];[x][1:v]${use}`, '-an', '-loop', '0', output],
  ];
}

/** Naive GIF (no palette pass) — for quality comparison only. */
export function gifNaiveArgs({ input, output, fps = 12, maxSide = 480 }) {
  return [...BASE, '-i', input, '-vf', `fps=${fps},${fitBox(maxSide)}`, '-an', '-loop', '0', output];
}

/**
 * Images -> animated GIF slideshow. Each input contributes its first frame, letterboxed onto a
 * WxH canvas (alpha flattened onto `bg`), shown `seconds` each.
 */
export function imagesToGifArgs({ inputs, output, seconds = 1.5, width = 640, height = 360, bg = 'white', fps = 2 }) {
  const a = [...BASE];
  inputs.forEach((f) => a.push('-i', f));
  const reps = Math.max(1, Math.round(seconds * fps)) - 1;
  const segs = inputs.map((_, i) =>
    `[${i}:v]select='eq(n\\,0)',${fitBoxWH(width, height)},format=rgba,` +
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black@0,setsar=1,` +
    `loop=loop=${reps}:size=1:start=0,setpts=N/${fps}/TB[s${i}]`).join(';');
  const total = inputs.length * (reps + 1) / fps;
  const graph = `${segs};${inputs.map((_, i) => `[s${i}]`).join('')}concat=n=${inputs.length}:v=1:a=0,fps=${fps}[cat];` +
    `color=c=${bg}:s=${width}x${height}:r=${fps}:d=${total}[bg];[bg][cat]overlay=shortest=1,split[x][y];` +
    `[x]palettegen=stats_mode=full[p];[y][p]paletteuse=dither=sierra2_4a`;
  a.push('-filter_complex', graph, '-loop', '0', output);
  return a;
}
const fitBoxWH = (w, h) => `scale=w=${w}:h=${h}:force_original_aspect_ratio=decrease:flags=lanczos`;

/** (a) one frame every N seconds — single process, decodes the whole stream. */
export function framesEveryArgs({ input, outPattern, every = 2, maxSide = 1280, maxFrames = 300, q = 3 }) {
  return [...BASE, '-i', input, '-vf', `fps=1/${every},${fitBox(maxSide)}`, '-frames:v', String(maxFrames),
    '-q:v', String(q), outPattern];
}

/** (a') one frame at time t — fast input seek; the caller loops t = 0, N, 2N ... (one process per frame). */
export function frameAtArgs({ input, output, t, maxSide = 1280, q = 3 }) {
  return [...BASE, '-ss', String(t), '-i', input, '-frames:v', '1', '-vf', fitBox(maxSide), '-q:v', String(q), output];
}

/** (b) scene-change frames; frame 0 always included; showinfo on stderr gives pts_time. */
export function framesSceneArgs({ input, outPattern, threshold = 0.3, maxSide = 1280, maxFrames = 300, q = 3, analyseSide = 0 }) {
  // analyseSide>0: downscale before scene scoring (faster), output at that size.
  const pre = analyseSide > 0 ? `${fitBox(analyseSide)},` : '';
  return ['-hide_banner', '-nostdin', '-n', '-loglevel', 'info', '-i', input,
    '-vf', `${pre}select='eq(n\\,0)+gt(scene\\,${threshold})',${fitBox(maxSide)},showinfo`,
    '-fps_mode', 'vfr', '-frames:v', String(maxFrames), '-q:v', String(q), outPattern];
}

/** Normalise any still/animated image or video frame to a baseline JPEG (first frame, EXIF/display
 *  rotation applied by ffmpeg, alpha flattened on white). Used before PDF/PPTX embedding. */
export function toJpegArgs({ input, output, maxSide = 2000, q = 2 }) {
  return [...BASE, '-i', input, '-frames:v', '1', '-filter_complex',
    `[0:v]${fitBox(maxSide)},format=rgba,split[i][s];[s]drawbox=c=white:t=fill[w];[w][i]overlay=format=auto,format=yuvj444p`,
    '-q:v', String(q), output];
}

/** Parse "pts_time:" values from showinfo stderr. */
export const ptsTimes = (stderr) => [...stderr.matchAll(/pts_time:([\d.]+)/g)].map((m) => Number(m[1]));
