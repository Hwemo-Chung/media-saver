/**
 * MPEG-DASH MPD parsing into absolute segment lists. DOM-free.
 */
import { parseXml, kids, kid } from './xml.js';
import { resolveUrl } from './hls.js';

/** ISO 8601 duration (PnDTnHnMnS) in seconds. */
export function parseIsoDuration(s) {
  if (!s) return 0;
  const m = /^P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(String(s).trim());
  if (!m) return 0;
  const [, y, mo, d, h, mi, sec] = m.map((x) => (x === undefined ? 0 : Number(x)));
  const total = (y * 365 * 86400) + (mo * 30 * 86400) + (d * 86400) + (h * 3600) + (mi * 60) + sec;
  return Math.round(total * 1e6) / 1e6;
}

/** Expand a SegmentTemplate string: $RepresentationID$, $Number%05d$, $Time$, $Bandwidth$, $$. */
export function expandTemplate(tpl, vars) {
  return String(tpl).replace(/\$(\w*)(?:%0(\d+)([diuxX]))?\$/g, (m, name, width, fmt) => {
    if (name === '') return '$';
    if (!(name in vars)) return m;
    let v = vars[name];
    if (typeof v === 'number' && (fmt === 'x' || fmt === 'X')) v = v.toString(16)[fmt === 'X' ? 'toUpperCase' : 'toLowerCase']();
    v = String(v);
    if (width) v = v.padStart(Number(width), '0');
    return v;
  });
}

function parseRange(r) {
  if (!r) return null;
  const m = /^(\d+)-(\d+)$/.exec(String(r).trim());
  if (!m) return null;
  const a = Number(m[1]); const b = Number(m[2]);
  return { offset: a, length: b - a + 1 };
}

function baseOf(el, parentBase) {
  const b = kid(el, 'BaseURL');
  return b && b.text ? resolveUrl(b.text, parentBase) : parentBase;
}

function hasProtection(el) {
  if (!el) return false;
  if (el.name === 'ContentProtection') return true;
  return el.children.some(hasProtection);
}

/** Merge SegmentTemplate attributes from adaptation-set level and representation level. */
function mergeTemplate(asTpl, repTpl) {
  if (!asTpl && !repTpl) return null;
  const attrs = { ...(asTpl ? asTpl.attrs : {}), ...(repTpl ? repTpl.attrs : {}) };
  const timeline = kid(repTpl, 'SegmentTimeline') || kid(asTpl, 'SegmentTimeline');
  return { attrs, timeline };
}

function templateSegments(tpl, ctx) {
  const a = tpl.attrs;
  const timescale = Number(a.timescale || 1);
  const startNumber = Number(a.startNumber ?? 1);
  const vars = { RepresentationID: ctx.id, Bandwidth: ctx.bandwidth };
  const init = a.initialization ? { url: resolveUrl(expandTemplate(a.initialization, vars), ctx.base), range: null } : null;
  const segments = [];
  if (!a.media) return { init, segments };
  if (tpl.timeline) {
    const ss = kids(tpl.timeline, 'S');
    const periodEnd = ctx.periodDuration > 0 ? ctx.periodDuration * timescale : Infinity;
    let t = 0; let n = startNumber;
    ss.forEach((s, idx) => {
      if (s.attrs.t !== undefined) t = Number(s.attrs.t);
      const d = Number(s.attrs.d);
      let r = Number(s.attrs.r || 0);
      if (r < 0) {
        const next = ss[idx + 1];
        const until = next && next.attrs.t !== undefined ? Number(next.attrs.t) : periodEnd;
        r = Number.isFinite(until) ? Math.max(0, Math.ceil((until - t) / d) - 1) : 0;
      }
      for (let k = 0; k <= r; k += 1) {
        segments.push({ url: resolveUrl(expandTemplate(a.media, { ...vars, Time: t, Number: n }), ctx.base), range: null, time: t / timescale, duration: d / timescale });
        t += d; n += 1;
      }
    });
  } else if (a.duration) {
    const segDur = Number(a.duration) / timescale;
    const count = ctx.periodDuration > 0 ? Math.ceil(ctx.periodDuration / segDur - 1e-9) : 0;
    for (let k = 0; k < count; k += 1) {
      segments.push({ url: resolveUrl(expandTemplate(a.media, { ...vars, Number: startNumber + k, Time: Math.round(k * Number(a.duration)) }), ctx.base), range: null, duration: segDur });
    }
  }
  return { init, segments };
}

function listSegments(list, base) {
  const ini = kid(list, 'Initialization');
  const init = ini ? { url: resolveUrl(ini.attrs.sourceURL || '', base), range: parseRange(ini.attrs.range) } : null;
  const segments = kids(list, 'SegmentURL').map((s) => ({
    url: s.attrs.media ? resolveUrl(s.attrs.media, base) : base,
    range: parseRange(s.attrs.mediaRange),
  }));
  return { init, segments };
}

function kindOf(mime, contentType, codecs) {
  const m = (mime || '').toLowerCase();
  const ct = (contentType || '').toLowerCase();
  const c = (codecs || '').toLowerCase();
  if (m.startsWith('video') || ct === 'video') return 'video';
  if (m.startsWith('audio') || ct === 'audio') return 'audio';
  if (m.startsWith('text') || ct === 'text' || /wvtt|stpp|ttml/.test(c) || m === 'application/ttml+xml') return 'text';
  if (/avc|hvc|hev|vp0?9|av01|dvh/.test(c)) return 'video';
  if (/mp4a|ac-3|ec-3|opus|flac/.test(c)) return 'audio';
  return 'video';
}

/**
 * @param {string} text MPD XML
 * @param {string} mpdUrl absolute URL of the MPD
 */
export function parseMpd(text, mpdUrl) {
  const mpd = parseXml(text);
  if (mpd.name !== 'MPD') throw new Error('Not an MPD document');
  const type = mpd.attrs.type || 'static';
  const duration = parseIsoDuration(mpd.attrs.mediaPresentationDuration);
  const periods = kids(mpd, 'Period');
  const drm = hasProtection(mpd);
  const mpdBase = baseOf(mpd, mpdUrl);
  const out = { type, live: type === 'dynamic', duration, periodCount: periods.length, drm, video: [], audio: [], text: [] };
  const period = periods[0];
  if (!period) return out;
  const pStart = parseIsoDuration(period.attrs.start);
  let periodDuration = parseIsoDuration(period.attrs.duration);
  if (!periodDuration) {
    const next = periods[1];
    if (next && next.attrs.start) periodDuration = parseIsoDuration(next.attrs.start) - pStart;
    else if (duration) periodDuration = duration - pStart;
  }
  if (!out.duration) out.duration = periodDuration;
  const pBase = baseOf(period, mpdBase);
  const pTpl = kid(period, 'SegmentTemplate');

  for (const as of kids(period, 'AdaptationSet')) {
    const asBase = baseOf(as, pBase);
    const asTpl = kid(as, 'SegmentTemplate') || pTpl;
    const asList = kid(as, 'SegmentList');
    const asSegBase = kid(as, 'SegmentBase');
    const label = (kid(as, 'Label') || {}).text || as.attrs.label || '';
    for (const rep of kids(as, 'Representation')) {
      const id = rep.attrs.id || '';
      const bandwidth = Number(rep.attrs.bandwidth || 0);
      const mimeType = rep.attrs.mimeType || as.attrs.mimeType || '';
      const codecs = rep.attrs.codecs || as.attrs.codecs || '';
      const base = baseOf(rep, asBase);
      const repTpl = kid(rep, 'SegmentTemplate');
      const repList = kid(rep, 'SegmentList') || asList;
      const repSegBase = kid(rep, 'SegmentBase') || asSegBase;
      let init = null; let segments = []; let single = false;
      const tpl = mergeTemplate(repTpl ? asTpl : asTpl, repTpl);
      if (repTpl || (asTpl && !kid(rep, 'SegmentList') && !kid(rep, 'SegmentBase') && !kid(rep, 'BaseURL'))) {
        ({ init, segments } = templateSegments(tpl, { id, bandwidth, base, periodDuration }));
      } else if (repList) {
        ({ init, segments } = listSegments(repList, base));
      } else {
        single = true;
        segments = [{ url: base, range: null }];
        if (repSegBase && !kid(rep, 'BaseURL') && !kid(as, 'BaseURL')) single = true;
      }
      const kind = kindOf(mimeType, as.attrs.contentType, codecs);
      const entry = {
        id,
        kind,
        bandwidth,
        width: Number(rep.attrs.width || as.attrs.width || 0),
        height: Number(rep.attrs.height || as.attrs.height || 0),
        codecs,
        mimeType,
        lang: rep.attrs.lang || as.attrs.lang || '',
        label,
        init,
        segments,
        single,
        hasAudio: kind === 'video' && /mp4a|ac-3|ec-3|opus/i.test(codecs),
        protected: hasProtection(as) || hasProtection(rep),
      };
      out[kind].push(entry);
    }
  }
  out.video.sort((a, b) => (b.height - a.height) || (b.bandwidth - a.bandwidth));
  out.audio.sort((a, b) => b.bandwidth - a.bandwidth);
  return out;
}
