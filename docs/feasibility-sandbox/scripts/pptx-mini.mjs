// [media-saver] feasibility prototype — dependency-free .pptx writer: one picture per slide.
// Minimal OOXML package (presentation + 1 master + 1 blank layout + theme + slides) in a hand-written
// ZIP (store for JPEG/PNG, deflate for XML). Node >= 22 for zlib.crc32. No ZIP64: < 4 GB, < 65535 parts.
import fs from 'node:fs';
import zlib from 'node:zlib';
import { jpegInfo } from './pdf-mini.mjs';

class ZipWriter {
  constructor(path) { this.fd = fs.openSync(path, 'wx'); this.pos = 0; this.entries = []; }
  #w(b) { fs.writeSync(this.fd, b); this.pos += b.length; }
  add(name, data) {                          // deflate; fall back to store when it saves < 5 % (photos)
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    const def = zlib.deflateRawSync(raw);
    const store = def.length > raw.length * 0.95;
    const body = store ? raw : def;
    const e = { name: Buffer.from(name, 'utf8'), crc: zlib.crc32(raw), csize: body.length, usize: raw.length,
      method: store ? 0 : 8, offset: this.pos };
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(e.method, 8);
    h.writeUInt16LE(0, 10); h.writeUInt16LE(0x21, 12);           // DOS time 00:00, date 1980-01-01
    h.writeUInt32LE(e.crc, 14); h.writeUInt32LE(e.csize, 18); h.writeUInt32LE(e.usize, 22);
    h.writeUInt16LE(e.name.length, 26); h.writeUInt16LE(0, 28);
    this.#w(h); this.#w(e.name); this.#w(body);
    this.entries.push(e);
  }
  close() {
    const cd = this.pos;
    for (const e of this.entries) {
      const c = Buffer.alloc(46);
      c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8);
      c.writeUInt16LE(e.method, 10); c.writeUInt16LE(0, 12); c.writeUInt16LE(0x21, 14); c.writeUInt32LE(e.crc, 16);
      c.writeUInt32LE(e.csize, 20); c.writeUInt32LE(e.usize, 24); c.writeUInt16LE(e.name.length, 28);
      c.writeUInt32LE(e.offset, 42);
      this.#w(c); this.#w(e.name);
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(this.entries.length, 8); end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(this.pos - cd, 12); end.writeUInt32LE(cd, 16);
    this.#w(end); fs.closeSync(this.fd);
  }
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
const X = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const CT = 'application/vnd.openxmlformats-officedocument.';
const rels = (list) => X + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  list.map(([id, type, target]) => `<Relationship Id="${id}" Type="${type}" Target="${target}"/>`).join('') + '</Relationships>';
const grp = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/>' +
  '<a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';
const clr = (n, v) => `<a:${n}><a:srgbClr val="${v}"/></a:${n}>`;
const THEME = X + `<a:theme ${NS.split(' ')[0]} name="Media Saver"><a:themeElements><a:clrScheme name="Media Saver">` +
  '<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>' +
  clr('dk2', '44546A') + clr('lt2', 'E7E6E6') + clr('accent1', '4472C4') + clr('accent2', 'ED7D31') + clr('accent3', 'A5A5A5') +
  clr('accent4', 'FFC000') + clr('accent5', '5B9BD5') + clr('accent6', '70AD47') + clr('hlink', '0563C1') + clr('folHlink', '954F72') +
  '</a:clrScheme><a:fontScheme name="Media Saver"><a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>' +
  '<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Media Saver">' +
  '<a:fillStyleLst>' + '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'.repeat(3) + '</a:fillStyleLst>' +
  '<a:lnStyleLst>' + '<a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>'.repeat(3) + '</a:lnStyleLst>' +
  '<a:effectStyleLst>' + '<a:effectStyle><a:effectLst/></a:effectStyle>'.repeat(3) + '</a:effectStyleLst>' +
  '<a:bgFillStyleLst>' + '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'.repeat(3) + '</a:bgFillStyleLst>' +
  '</a:fmtScheme></a:themeElements></a:theme>';

/**
 * @param {string} outPath created with 'wx'
 * @param {Array<{jpegPath:string, caption?:string}>} images  baseline JPEGs (normalise with ffmpeg first)
 * @param {{title?:string, cx?:number, cy?:number, bg?:string}} opts  slide size in EMU (default 16:9)
 */
export function writePptx(outPath, images, { title = '', cx = 12192000, cy = 6858000, bg = '000000' } = {}) {
  const z = new ZipWriter(outPath);
  const n = images.length;
  z.add('[Content_Types].xml', X + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/><Default Extension="jpeg" ContentType="image/jpeg"/>' +
    `<Override PartName="/ppt/presentation.xml" ContentType="${CT}presentationml.presentation.main+xml"/>` +
    `<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="${CT}presentationml.slideMaster+xml"/>` +
    `<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="${CT}presentationml.slideLayout+xml"/>` +
    `<Override PartName="/ppt/theme/theme1.xml" ContentType="${CT}theme+xml"/>` +
    `<Override PartName="/ppt/presProps.xml" ContentType="${CT}presentationml.presProps+xml"/>` +
    `<Override PartName="/ppt/viewProps.xml" ContentType="${CT}presentationml.viewProps+xml"/>` +
    `<Override PartName="/ppt/tableStyles.xml" ContentType="${CT}presentationml.tableStyles+xml"/>` +
    images.map((_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="${CT}presentationml.slide+xml"/>`).join('') +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    `<Override PartName="/docProps/app.xml" ContentType="${CT}extended-properties+xml"/></Types>`);
  z.add('_rels/.rels', rels([['rId1', `${R}/officeDocument`, 'ppt/presentation.xml'],
    ['rId2', 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties', 'docProps/core.xml'],
    ['rId3', `${R}/extended-properties`, 'docProps/app.xml']]));
  z.add('docProps/core.xml', X + '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    `<dc:title>${esc(title)}</dc:title><dc:creator>Media Saver</dc:creator>` +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString().slice(0, 19)}Z</dcterms:created></cp:coreProperties>`);
  z.add('docProps/app.xml', X + '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">' +
    `<Application>Media Saver</Application><Slides>${n}</Slides></Properties>`);
  z.add('ppt/presentation.xml', X + `<p:presentation ${NS}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>` +
    `<p:sldIdLst>${images.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 3}"/>`).join('')}</p:sldIdLst>` +
    `<p:sldSz cx="${cx}" cy="${cy}"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`);
  z.add('ppt/_rels/presentation.xml.rels', rels([['rId1', `${R}/slideMaster`, 'slideMasters/slideMaster1.xml'],
    ['rId2', `${R}/theme`, 'theme/theme1.xml'], ...images.map((_, i) => [`rId${i + 3}`, `${R}/slide`, `slides/slide${i + 1}.xml`]),
    [`rId${n + 3}`, `${R}/presProps`, 'presProps.xml'], [`rId${n + 4}`, `${R}/viewProps`, 'viewProps.xml'],
    [`rId${n + 5}`, `${R}/tableStyles`, 'tableStyles.xml']]));
  z.add('ppt/theme/theme1.xml', THEME);
  // optional per schema, but PowerPoint, python-pptx and pptxgenjs all write them — kept for parity
  z.add('ppt/presProps.xml', X + `<p:presentationPr ${NS}/>`);
  z.add('ppt/viewProps.xml', X + `<p:viewPr ${NS}><p:gridSpacing cx="76200" cy="76200"/></p:viewPr>`);
  z.add('ppt/tableStyles.xml', X + `<a:tblStyleLst ${NS.split(' ')[0]} def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>`);
  z.add('ppt/slideMasters/slideMaster1.xml', X + `<p:sldMaster ${NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>` +
    `<p:spTree>${grp}</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" ` +
    'accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>' +
    '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>' +
    '<p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>');
  z.add('ppt/slideMasters/_rels/slideMaster1.xml.rels', rels([['rId1', `${R}/slideLayout`, '../slideLayouts/slideLayout1.xml'],
    ['rId2', `${R}/theme`, '../theme/theme1.xml']]));
  z.add('ppt/slideLayouts/slideLayout1.xml', X + `<p:sldLayout ${NS} type="blank" preserve="1"><p:cSld name="Blank">` +
    `<p:spTree>${grp}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`);
  z.add('ppt/slideLayouts/_rels/slideLayout1.xml.rels', rels([['rId1', `${R}/slideMaster`, '../slideMasters/slideMaster1.xml']]));

  images.forEach((im, i) => {
    const jpg = fs.readFileSync(im.jpegPath);
    const { width, height } = jpegInfo(jpg);
    const s = Math.min(cx / width, cy / height);                      // contain
    const [w, h] = [Math.round(width * s), Math.round(height * s)];
    const [x, y] = [Math.round((cx - w) / 2), Math.round((cy - h) / 2)];
    z.add(`ppt/media/image${i + 1}.jpeg`, jpg);
    z.add(`ppt/slides/slide${i + 1}.xml`, X + `<p:sld ${NS}><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="${bg}"/></a:solidFill>` +
      `<a:effectLst/></p:bgPr></p:bg><p:spTree>${grp}<p:pic><p:nvPicPr><p:cNvPr id="2" name="Picture ${i + 1}" descr="${esc(im.caption ?? '')}"/>` +
      '<p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId2"/>' +
      `<a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm>` +
      '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic></p:spTree></p:cSld>' +
      '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>');
    z.add(`ppt/slides/_rels/slide${i + 1}.xml.rels`, rels([['rId1', `${R}/slideLayout`, '../slideLayouts/slideLayout1.xml'],
      ['rId2', `${R}/image`, `../media/image${i + 1}.jpeg`]]));
  });
  z.close();
  return { path: outPath, slides: n, bytes: fs.statSync(outPath).size };
}
