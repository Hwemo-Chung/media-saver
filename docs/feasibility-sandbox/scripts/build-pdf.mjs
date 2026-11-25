// [media-saver] Q2 — build a PDF from a frames manifest with either engine.
// usage: node build-pdf.mjs <mini|pdflib> <image|a4> <manifest.json> <out.pdf> [title]
import fs from 'node:fs';
import { writePdf } from './pdf-mini.mjs';

const [engine, fit, manifestPath, out, title = ''] = process.argv.slice(2);
const pages = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
if (fs.existsSync(out)) fs.unlinkSync(out);
const t0 = performance.now();
if (engine === 'mini') {
  writePdf(out, pages, { fit, title });
} else {
  const { PDFDocument, StandardFonts } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  doc.setTitle(title);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const p of pages) {
    // copy: pdf-lib 1.17.1 builds DataView(data.buffer) and ignores byteOffset; Node pools small
    // Buffers (byteOffset != 0) -> "SOI not found in JPEG" without this copy.
    const img = await doc.embedJpg(new Uint8Array(fs.readFileSync(p.jpegPath)));
    const cap = 22;
    if (fit === 'a4') {
      const [pw, ph] = img.width > img.height ? [841.89, 595.28] : [595.28, 841.89];
      const s = Math.min((pw - 48) / img.width, (ph - 48 - cap) / img.height);
      const page = doc.addPage([pw, ph]);
      page.drawImage(img, { x: (pw - img.width * s) / 2, y: cap + (ph - cap - img.height * s) / 2, width: img.width * s, height: img.height * s });
      page.drawText(p.caption.replace(/[^\x20-\x7e]/g, '?'), { x: 24, y: 7, size: 10, font });
    } else {
      const [w, h] = [img.width * 0.75, img.height * 0.75];
      const page = doc.addPage([w, h + cap]);
      page.drawImage(img, { x: 0, y: cap, width: w, height: h });
      page.drawText(p.caption.replace(/[^\x20-\x7e]/g, '?'), { x: 6, y: 7, size: 10, font });
    }
  }
  fs.writeFileSync(out, await doc.save());
}
console.log(JSON.stringify({ engine, fit, out, pages: pages.length, ms: Math.round(performance.now() - t0),
  bytes: fs.statSync(out).size, peakRssMB: Math.round(process.resourceUsage().maxRSS / 1024) }));
