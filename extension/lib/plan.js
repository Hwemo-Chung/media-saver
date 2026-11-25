/**
 * Turn parsed HLS/DASH manifests into the user-facing choices shown in the
 * popup (quality, audio-only, subtitles). Pure.
 */

export function estimateBytes(bandwidth, durationSec) {
  if (!bandwidth || !durationSec) return 0;
  return Math.round((bandwidth * durationSec) / 8);
}

export function formatBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
  if (i === 0) return `${v} B`;
  return `${i >= 3 ? v.toFixed(2) : v.toFixed(1)} ${u[i]}`;
}

export function formatDuration(sec) {
  if (!sec || !Number.isFinite(sec)) return '';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); const r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}

const mbps = (bw) => (bw ? ` · ${(bw / 1e6).toFixed(1)} Mbps` : '');

function pickAudio(renditions, group) {
  const inGroup = renditions.filter((r) => r.groupId === group);
  if (!inGroup.length) return null;
  const chosen = inGroup.find((r) => r.default) || inGroup.find((r) => r.autoselect) || inGroup[0];
  return chosen.uri ? chosen : null;
}

function isAudioOnlyVariant(v) {
  return !v.height && /mp4a|ac-3|ec-3|opus|mp3/i.test(v.codecs) && !/avc|hvc|hev|vp0?9|av01/i.test(v.codecs);
}

/**
 * @param {ReturnType<import('./hls.js').parseMaster>} master
 * @param {number} durationSec
 */
export function hlsOptions(master, durationSec) {
  const out = [];
  const seen = new Set();
  for (const v of master.variants) {
    if (isAudioOnlyVariant(v)) continue;
    const key = `${v.height}|${v.bandwidth}|${v.codecs}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const audio = v.audioGroup ? pickAudio(master.audio, v.audioGroup) : null;
    out.push({
      id: `v${out.length}`,
      label: `${v.height ? `${v.height}p` : (v.name || '기본 화질')}${mbps(v.bandwidth)}`,
      height: v.height,
      bandwidth: v.bandwidth,
      videoUri: v.uri,
      audioUri: audio ? audio.uri : null,
      audioOnly: false,
      estBytes: estimateBytes(v.bandwidth, durationSec),
    });
  }
  const audioSeen = new Set();
  for (const a of master.audio) {
    if (!a.uri || audioSeen.has(a.uri)) continue;
    audioSeen.add(a.uri);
    out.push({
      id: `a${out.length}`,
      label: `오디오만 · ${a.name || a.language || '기본'}`,
      height: 0, bandwidth: 0, videoUri: null, audioUri: a.uri, audioOnly: true, estBytes: 0,
    });
  }
  for (const v of master.variants) {
    if (!isAudioOnlyVariant(v)) continue;
    out.push({
      id: `a${out.length}`,
      label: `오디오만${mbps(v.bandwidth)}`,
      height: 0, bandwidth: v.bandwidth, videoUri: v.uri, audioUri: null, audioOnly: true,
      estBytes: estimateBytes(v.bandwidth, durationSec),
    });
  }
  return out;
}

export function hlsSubtitleOptions(master) {
  const seen = new Set();
  const out = [];
  for (const s of master.subtitles) {
    if (!s.uri || seen.has(s.uri)) continue;
    seen.add(s.uri);
    out.push({ id: `s${out.length}`, label: `${s.name || s.language}${s.language ? ` (${s.language})` : ''}`, lang: s.language || 'und', uri: s.uri });
  }
  return out;
}

/**
 * @param {ReturnType<import('./dash.js').parseMpd>} mpd
 */
export function dashOptions(mpd) {
  const out = [];
  const audios = [...mpd.audio].sort((a, b) => b.bandwidth - a.bandwidth);
  const bestAudio = audios[0] || null;
  const seen = new Set();
  for (const v of mpd.video) {
    const key = `${v.height}|${v.bandwidth}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const audio = v.hasAudio ? null : bestAudio;
    out.push({
      id: `v${out.length}`,
      label: `${v.height ? `${v.height}p` : '기본 화질'}${mbps(v.bandwidth)}`,
      height: v.height,
      bandwidth: v.bandwidth,
      videoId: v.id,
      audioId: audio ? audio.id : null,
      audioOnly: false,
      estBytes: estimateBytes(v.bandwidth + (audio ? audio.bandwidth : 0), mpd.duration),
    });
  }
  const byLang = new Map();
  for (const a of audios) {
    const lang = a.lang || 'und';
    if (!byLang.has(lang)) byLang.set(lang, a);
  }
  for (const [lang, a] of byLang) {
    out.push({
      id: `a${out.length}`,
      label: `오디오만 · ${a.label || lang}${mbps(a.bandwidth)}`,
      height: 0, bandwidth: a.bandwidth, videoId: null, audioId: a.id, audioOnly: true,
      estBytes: estimateBytes(a.bandwidth, mpd.duration),
    });
  }
  return out;
}

export function dashSubtitleOptions(mpd) {
  return mpd.text
    .filter((t) => /text\/vtt/i.test(t.mimeType) || (/wvtt/i.test(t.codecs) && t.single))
    .filter((t) => /text\/vtt/i.test(t.mimeType))
    .map((t, i) => ({ id: `s${i}`, label: `${t.label || t.lang || '자막'}${t.lang ? ` (${t.lang})` : ''}`, lang: t.lang || 'und', repId: t.id }));
}
