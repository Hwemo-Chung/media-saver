#!/usr/bin/env node
// Helper for tests/fixtures/make.sh and tests/server/selfcheck.sh. Node built-ins only.
//
//   node fixture-tool.mjs avc1 <file.mp4>              -> codec string from avcC, e.g. avc1.64001f
//   node fixture-tool.mjs bw <media.m3u8> [extra...]   -> "<peak> <average>" bits/s over the playlist's
//                                                         segments (extra files are added to the first one)
//   node fixture-tool.mjs sidx <file.mp4>              -> "<initRange> <indexRange> <refs>" for SegmentBase
//   node fixture-tool.mjs dash-fetch <mpd path|URL> <outDir> ['Header: value' ...]
//        Downloads (or reads) init + media segments of every Representation in the first Period,
//        writes <outDir>/<repId>.mp4 or .m4a, prints one JSON line per representation, then
//        "best-video=<path>" and "audio=<path>" lines. Supports SegmentTemplate ($Number$, $Time$,
//        $RepresentationID$, $Bandwidth$, %0Nd) with SegmentTimeline or @duration, and SegmentBase.
//        It is a test oracle for the fixtures, not a general DASH client.

import fs from 'node:fs';
import path from 'node:path';

const [cmd, ...args] = process.argv.slice(2);

/** Top-level ISO-BMFF boxes of buf between start and end. */
function boxes(buf, start = 0, end = buf.length) {
  const out = [];
  let off = start;
  while (off + 8 <= end) {
    let size = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    let hdr = 8;
    if (size === 1) { size = Number(buf.readBigUInt64BE(off + 8)); hdr = 16; }
    else if (size === 0) size = end - off;
    if (size < hdr || off + size > end) throw new Error(`bad box "${type}" at ${off}`);
    out.push({ type, start: off, end: off + size, hdr });
    off += size;
  }
  return out;
}

function avc1(file) {
  const buf = fs.readFileSync(file);
  const i = buf.indexOf('avcC', 0, 'latin1');
  if (i < 0 || buf[i + 4] !== 1) throw new Error(`no avcC in ${file}`);
  const hex = (b) => b.toString(16).padStart(2, '0');
  return `avc1.${hex(buf[i + 5])}${hex(buf[i + 6])}${hex(buf[i + 7])}`;
}

function bandwidth(playlist, extra) {
  const dir = path.dirname(playlist);
  const lines = fs.readFileSync(playlist, 'utf8').split(/\r?\n/).map((l) => l.trim());
  const segs = [];
  let dur = null;
  for (const l of lines) {
    if (l.startsWith('#EXTINF:')) dur = parseFloat(l.slice(8));
    else if (l && !l.startsWith('#') && dur !== null) {
      segs.push({ dur, bytes: fs.statSync(path.join(dir, l)).size });
      dur = null;
    }
  }
  if (!segs.length) throw new Error(`no segments in ${playlist}`);
  for (const f of extra) segs[0].bytes += fs.statSync(f).size;
  let peak = 0, bits = 0, secs = 0;
  for (const s of segs) {
    peak = Math.max(peak, (s.bytes * 8) / s.dur);
    bits += s.bytes * 8;
    secs += s.dur;
  }
  return `${Math.ceil(peak)} ${Math.ceil(bits / secs)}`;
}

function sidx(file) {
  const buf = fs.readFileSync(file);
  const top = boxes(buf);
  const moov = top.find((b) => b.type === 'moov');
  const sx = top.find((b) => b.type === 'sidx');
  if (!moov || !sx) throw new Error(`${file}: need moov and sidx, have ${top.map((b) => b.type).join(',')}`);
  // sidx: version(1) flags(3) reference_ID(4) timescale(4) then 32- or 64-bit times, reserved(2), count(2)
  const p = sx.start + sx.hdr;
  const version = buf[p];
  const countAt = p + 12 + (version === 0 ? 8 : 16) + 2;
  const refs = buf.readUInt16BE(countAt);
  return `0-${moov.end - 1} ${sx.start}-${sx.end - 1} ${refs}`;
}

// ---- minimal XML reader (enough for MPDs this repo writes or ffmpeg writes) ----
function parseXml(text) {
  const root = { name: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  const re = /<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*"[^"]*")*)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(text))) {
    if (m[5] !== undefined) { stack[stack.length - 1].text += m[5]; continue; }
    if (!m[2]) continue;
    if (m[1]) { stack.pop(); continue; }
    const attrs = {};
    for (const a of m[3].matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) attrs[a[1]] = a[2].replace(/&amp;/g, '&');
    const el = { name: m[2].replace(/^.*:/, ''), attrs, children: [], text: '' };
    stack[stack.length - 1].children.push(el);
    if (!m[4]) stack.push(el);
  }
  return root;
}
const kids = (el, name) => (el ? el.children.filter((c) => c.name === name) : []);
const kid = (el, name) => kids(el, name)[0];

function isoDuration(s) {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?$/.exec(s || '');
  if (!m) return NaN;
  return (+(m[1] || 0)) * 86400 + (+(m[2] || 0)) * 3600 + (+(m[3] || 0)) * 60 + (+(m[4] || 0));
}

function fillTemplate(t, vars) {
  return t.replace(/\$(RepresentationID|Number|Time|Bandwidth)(%0(\d+)d)?\$/g, (_, k, __, w) => {
    const v = String(vars[k]);
    return w ? v.padStart(+w, '0') : v;
  }).replace(/\$\$/g, '$');
}

async function load(url, headers) {
  if (/^https?:/.test(url)) {
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    return Buffer.from(await res.arrayBuffer());
  }
  return fs.readFileSync(url.startsWith('file:') ? new URL(url) : url);
}

function resolveUrl(base, rel) {
  if (/^https?:/.test(base) || base.startsWith('file:')) return new URL(rel, base).href;
  return path.resolve(path.dirname(base), rel);
}

async function dashFetch(mpdUrl, outDir, headerLines) {
  const headers = {};
  for (const h of headerLines) {
    const i = h.indexOf(':');
    headers[h.slice(0, i).trim()] = h.slice(i + 1).trim();
  }
  const mpdText = (await load(mpdUrl, headers)).toString('utf8');
  const mpd = kid(parseXml(mpdText), 'MPD');
  const total = isoDuration(mpd.attrs.mediaPresentationDuration);
  const period = kid(mpd, 'Period');
  const baseOf = (el, base) => {
    const b = kid(el, 'BaseURL');
    return b ? resolveUrl(base, b.text.trim()) : base;
  };
  let base = baseOf(period, baseOf(mpd, mpdUrl));
  fs.mkdirSync(outDir, { recursive: true });
  const results = [];
  for (const as of kids(period, 'AdaptationSet')) {
    const asBase = baseOf(as, base);
    for (const rep of kids(as, 'Representation')) {
      const id = rep.attrs.id;
      const bw = +rep.attrs.bandwidth || 0;
      const mime = rep.attrs.mimeType || as.attrs.mimeType || '';
      const ctype = rep.attrs.contentType || as.attrs.contentType || mime.split('/')[0];
      const repBase = baseOf(rep, asBase);
      const tpl = kid(rep, 'SegmentTemplate') || kid(as, 'SegmentTemplate');
      const sb = kid(rep, 'SegmentBase') || kid(as, 'SegmentBase');
      const urls = [];
      let mode;
      if (tpl) {
        const vars = { RepresentationID: id, Bandwidth: bw };
        const ts = +(tpl.attrs.timescale || 1);
        let num = +(tpl.attrs.startNumber ?? 1);
        if (tpl.attrs.initialization) urls.push(resolveUrl(repBase, fillTemplate(tpl.attrs.initialization, vars)));
        const tl = kid(tpl, 'SegmentTimeline');
        if (tl) {
          mode = 'timeline';
          let t = 0;
          for (const s of kids(tl, 'S')) {
            if (s.attrs.t !== undefined) t = +s.attrs.t;
            const d = +s.attrs.d;
            let r = +(s.attrs.r || 0);
            if (r < 0) r = Math.ceil((total * ts - t) / d) - 1;
            for (let k = 0; k <= r; k++, t += d, num++) {
              urls.push(resolveUrl(repBase, fillTemplate(tpl.attrs.media, { ...vars, Number: num, Time: t })));
            }
          }
        } else {
          mode = 'number';
          const count = Math.ceil((total * ts) / +tpl.attrs.duration - 1e-9);
          for (let k = 0; k < count; k++, num++) {
            urls.push(resolveUrl(repBase, fillTemplate(tpl.attrs.media, { ...vars, Number: num, Time: 0 })));
          }
        }
      } else if (sb || kid(rep, 'BaseURL')) {
        mode = 'base';
        urls.push(repBase);
      } else {
        throw new Error(`representation ${id}: no SegmentTemplate or SegmentBase`);
      }
      const parts = [];
      for (const u of urls) parts.push(await load(u, headers));
      const file = path.join(outDir, `${id}.${ctype === 'audio' ? 'm4a' : 'mp4'}`);
      const data = Buffer.concat(parts);
      fs.writeFileSync(file, data);
      const r = { id, contentType: ctype, bandwidth: bw, mode, requests: urls.length, bytes: data.length, file };
      results.push(r);
      console.log(JSON.stringify(r));
    }
  }
  const videos = results.filter((r) => r.contentType === 'video').sort((a, b) => b.bandwidth - a.bandwidth);
  const audio = results.find((r) => r.contentType === 'audio');
  if (videos[0]) console.log(`best-video=${videos[0].file}`);
  if (audio) console.log(`audio=${audio.file}`);
}

try {
  if (cmd === 'avc1') console.log(avc1(args[0]));
  else if (cmd === 'bw') console.log(bandwidth(args[0], args.slice(1)));
  else if (cmd === 'sidx') console.log(sidx(args[0]));
  else if (cmd === 'dash-fetch') await dashFetch(args[0], args[1], args.slice(2));
  else {
    console.error('usage: fixture-tool.mjs avc1|bw|sidx|dash-fetch ...');
    process.exit(2);
  }
} catch (e) {
  console.error(`fixture-tool ${cmd}: ${e.message}`);
  process.exit(1);
}
