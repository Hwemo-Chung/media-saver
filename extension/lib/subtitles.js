/**
 * WebVTT helpers: parse, merge HLS subtitle segments, convert to SRT.
 */

function parseTime(s) {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/.exec(s.trim());
  if (!m) return NaN;
  return (Number(m[1] || 0) * 3600) + (Number(m[2]) * 60) + Number(m[3]) + (Number(m[4].padEnd(3, '0')) / 1000);
}

function fmt(t, sep) {
  const ms = Math.max(0, Math.round(t * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const r = ms % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}${sep}${String(r).padStart(3, '0')}`;
}

export const formatVttTime = (t) => fmt(t, '.');
export const formatSrtTime = (t) => fmt(t, ',');

/**
 * @returns {{cues:{start:number,end:number,settings:string,text:string}[], timestampMap:{mpegts:number,local:number}|null}}
 */
export function parseVtt(text) {
  const blocks = String(text).replace(/^﻿/, '').replace(/\r\n?/g, '\n').split(/\n{2,}/);
  const cues = [];
  let timestampMap = null;
  for (const block of blocks) {
    const ls = block.split('\n').filter((l, i, arr) => !(i === arr.length - 1 && l === ''));
    if (!ls.length) continue;
    if (ls[0].startsWith('WEBVTT')) {
      for (const l of ls) {
        const m = /X-TIMESTAMP-MAP=(.*)$/.exec(l);
        if (m) {
          const mp = /MPEGTS:(\d+)/.exec(m[1]);
          const lc = /LOCAL:([\d:.]+)/.exec(m[1]);
          timestampMap = { mpegts: mp ? Number(mp[1]) : 0, local: lc ? parseTime(lc[1]) : 0 };
        }
      }
      continue;
    }
    if (/^(NOTE|STYLE|REGION)\b/.test(ls[0])) continue;
    const ti = ls.findIndex((l) => l.includes('-->'));
    if (ti < 0) continue;
    const [a, rest] = ls[ti].split('-->');
    const restTrim = rest.trim();
    const sp = restTrim.indexOf(' ');
    const endStr = sp >= 0 ? restTrim.slice(0, sp) : restTrim;
    const settings = sp >= 0 ? restTrim.slice(sp + 1).trim() : '';
    const start = parseTime(a); const end = parseTime(endStr);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    cues.push({ start, end, settings, text: ls.slice(ti + 1).join('\n') });
  }
  return { cues, timestampMap };
}

function serializeVtt(cues) {
  const body = cues.map((c) => `${formatVttTime(c.start)} --> ${formatVttTime(c.end)}${c.settings ? ` ${c.settings}` : ''}\n${c.text}`).join('\n\n');
  return `WEBVTT\n\n${body}\n`;
}

/**
 * Merge HLS WebVTT segments into one file. Segments whose X-TIMESTAMP-MAP
 * MPEGTS differs from the first segment are shifted by the difference.
 */
export function mergeVttSegments(texts) {
  const all = [];
  const seen = new Set();
  let baseTs = null;
  for (const t of texts) {
    const { cues, timestampMap } = parseVtt(t);
    let shift = 0;
    if (timestampMap) {
      const ts = timestampMap.mpegts / 90000 - timestampMap.local;
      if (baseTs === null) baseTs = ts;
      shift = ts - baseTs;
    }
    for (const c of cues) {
      const cue = { ...c, start: c.start + shift, end: c.end + shift };
      const key = `${cue.start.toFixed(3)}|${cue.end.toFixed(3)}|${cue.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      all.push(cue);
    }
  }
  all.sort((a, b) => a.start - b.start || a.end - b.end);
  return serializeVtt(all);
}

/** Convert WebVTT text to SRT (drops cue settings and inline tags except <i><b><u>). */
export function vttToSrt(vtt) {
  const { cues } = parseVtt(vtt);
  return `${cues.map((c, i) => `${i + 1}\n${formatSrtTime(c.start)} --> ${formatSrtTime(c.end)}\n${c.text.replace(/<(?!\/?[ibu]>)[^>]+>/g, '')}`).join('\n\n')}\n`;
}
