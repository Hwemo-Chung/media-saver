// [media-saver] Q3 — frames/images -> .pptx with (b) the hand-built writer and (a) pptxgenjs.
// usage: node q3-pptx.mjs <mini|pptxgenjs> <manifest.json> <out.pptx> [title]
import fs from 'node:fs';
import { writePptx } from './pptx-mini.mjs';
import { jpegInfo } from './pdf-mini.mjs';

const [engine, manifestPath, out, title = ''] = process.argv.slice(2);
const items = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
if (fs.existsSync(out)) fs.unlinkSync(out);
const t0 = performance.now();
if (engine === 'mini') {
  writePptx(out, items, { title });
} else {
  const { default: PptxGenJS } = await import('pptxgenjs');
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';                       // 13.333 x 7.5 in = 12192000 x 6858000 EMU
  pptx.title = title;
  const [SW, SH] = [13.333, 7.5];
  for (const it of items) {
    const { width, height } = jpegInfo(fs.readFileSync(it.jpegPath));
    const s = Math.min(SW / width, SH / height);
    const [w, h] = [width * s, height * s];
    const slide = pptx.addSlide();
    slide.background = { color: '000000' };
    slide.addImage({ path: it.jpegPath, x: (SW - w) / 2, y: (SH - h) / 2, w, h, altText: it.caption ?? '' });
  }
  await pptx.writeFile({ fileName: out });
}
console.log(JSON.stringify({ engine, out, slides: items.length, ms: Math.round(performance.now() - t0),
  bytes: fs.statSync(out).size, peakRssMB: Math.round(process.resourceUsage().maxRSS / 1024) }));
