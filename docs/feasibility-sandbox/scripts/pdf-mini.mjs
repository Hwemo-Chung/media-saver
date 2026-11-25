// [media-saver] feasibility prototype — dependency-free multi-page PDF writer.
// JPEG pages are embedded as-is (/DCTDecode, no re-encode); raw RGB pages use /FlateDecode (lossless).
// Streams to disk one page at a time (constant memory), computes xref offsets from byte counts.
import fs from 'node:fs';
import zlib from 'node:zlib';

/** Read width/height/components from the JPEG SOFn marker. */
export function jpegInfo(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error('not a JPEG');
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) throw new Error(`bad JPEG marker at ${i}`);
    const m = buf[i + 1];
    if (m === 0xff) { i += 1; continue; }                                   // fill byte
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd8)) { i += 2; continue; }       // markers without length
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return { bits: buf[i + 4], height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7),
        comps: buf[i + 9], progressive: m === 0xc2 };
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  throw new Error('JPEG SOF marker not found');
}

const A4 = [595.28, 841.89];
const pdfText = (s) => '<' + Buffer.from('﻿' + s, 'utf16le').swap16().toString('hex') + '>'; // UTF-16BE
const ascii = (s) => s.replace(/[^\x20-\x7e]/g, '?').replace(/[\\()]/g, (c) => '\\' + c);
const n2 = (x) => (Math.round(x * 100) / 100).toString();

/**
 * @param {string} outPath  created with flag 'wx' (never overwrites)
 * @param {Array<{jpegPath?:string, jpeg?:Buffer, rgb?:Buffer, width?:number, height?:number, caption?:string}>} pages
 * @param {{fit?:'image'|'a4', margin?:number, title?:string, dpi?:number}} opts
 *   fit 'image': page = image size at `dpi` (default 96).  fit 'a4': A4, orientation follows the image, contain.
 */
export function writePdf(outPath, pages, { fit = 'image', margin = 24, title = '', dpi = 96 } = {}) {
  const fd = fs.openSync(outPath, 'wx');
  let pos = 0;
  const offsets = [];
  const w = (d) => { const b = typeof d === 'string' ? Buffer.from(d, 'latin1') : d; fs.writeSync(fd, b); pos += b.length; };
  const obj = (n, dict, stream) => {
    offsets[n] = pos;
    w(`${n} 0 obj\n${dict}\n`);
    if (stream) { w('stream\n'); w(stream); w('\nendstream\n'); }
    w('endobj\n');
  };
  try {
    w('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n');
    const kids = [];
    pages.forEach((pg, k) => {
      const [pageId, contId, imgId] = [5 + k * 3, 6 + k * 3, 7 + k * 3];
      kids.push(`${pageId} 0 R`);
      let img, iw, ih, dict;
      if (pg.rgb) {                                         // lossless path: raw rgb24 bytes
        [iw, ih] = [pg.width, pg.height];
        img = zlib.deflateSync(pg.rgb);
        dict = `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode`;
      } else {                                              // JPEG passthrough
        img = pg.jpeg ?? fs.readFileSync(pg.jpegPath);
        const info = jpegInfo(img);
        if (info.comps !== 1 && info.comps !== 3) throw new Error(`unsupported JPEG components ${info.comps} (CMYK?) — re-encode first`);
        [iw, ih] = [info.width, info.height];
        dict = `/ColorSpace /${info.comps === 1 ? 'DeviceGray' : 'DeviceRGB'} /BitsPerComponent 8 /Filter /DCTDecode`;
      }
      const capH = pg.caption ? 22 : 0;
      let pw, ph, dw, dh, x, y;
      if (fit === 'a4') {
        [pw, ph] = iw > ih ? [A4[1], A4[0]] : A4;
        const s = Math.min((pw - 2 * margin) / iw, (ph - 2 * margin - capH) / ih);
        [dw, dh] = [iw * s, ih * s];
        [x, y] = [(pw - dw) / 2, capH + (ph - capH - dh) / 2];
      } else {
        const s = 72 / dpi;
        [dw, dh] = [iw * s, ih * s];
        [pw, ph, x, y] = [dw, dh + capH, 0, capH];
      }
      let cs = `q ${n2(dw)} 0 0 ${n2(dh)} ${n2(x)} ${n2(y)} cm /Im0 Do Q`;
      if (pg.caption) cs += `\nBT /F1 10 Tf ${n2(Math.max(x, 6))} 7 Td (${ascii(pg.caption)}) Tj ET`;
      obj(pageId, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${n2(pw)} ${n2(ph)}] ` +
        `/Resources << /XObject << /Im0 ${imgId} 0 R >> /Font << /F1 3 0 R >> >> /Contents ${contId} 0 R >>`);
      obj(contId, `<< /Length ${Buffer.byteLength(cs, 'latin1')} >>`, Buffer.from(cs, 'latin1'));
      obj(imgId, `<< /Type /XObject /Subtype /Image /Width ${iw} /Height ${ih} ${dict} /Length ${img.length} >>`, img);
    });
    obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
    obj(2, `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${kids.length} >>`);
    obj(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    const d = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    obj(4, `<< /Title ${pdfText(title)} /Producer (Media Saver) /CreationDate (D:${d}Z) >>`);
    const xref = pos;
    const size = offsets.length;
    w(`xref\n0 ${size}\n0000000000 65535 f \n`);
    for (let n = 1; n < size; n++) w(`${String(offsets[n]).padStart(10, '0')} 00000 n \n`);
    w(`trailer\n<< /Size ${size} /Root 1 0 R /Info 4 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  } finally {
    fs.closeSync(fd);
  }
  return { path: outPath, pages: pages.length, bytes: pos };
}
