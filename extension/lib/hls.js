/**
 * HLS (RFC 8216) playlist parsing. DOM-free so it runs in the service worker,
 * the offscreen document and Node tests alike.
 */

const DRM_KEYFORMATS = [
  'com.apple.streamingkeydelivery', // FairPlay
  'urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed', // Widevine
  'com.microsoft.playready',
  'urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95', // PlayReady
];

/** Resolve a possibly relative URI against a base URL. */
export function resolveUrl(uri, base) {
  try { return new URL(uri, base).href; } catch { return uri; }
}

/**
 * Parse an HLS attribute list (`KEY=VALUE,KEY="quoted, value"`).
 * @param {string} str
 * @returns {Record<string,string>}
 */
export function parseAttributeList(str) {
  const out = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)(?:,|$)/g;
  let m;
  while ((m = re.exec(str)) !== null) {
    if (m.index === re.lastIndex) re.lastIndex += 1;
    let v = m[2];
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

function lines(text) {
  return String(text).replace(/^﻿/, '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
}

/** @returns {boolean} true when the playlist lists variants rather than segments. */
export function isMasterPlaylist(text) {
  return /#EXT-X-STREAM-INF:/i.test(text);
}

/** 16-byte IV from a 128-bit big-endian media sequence number. */
export function ivForSequence(seq) {
  const iv = new Uint8Array(16);
  let n = BigInt(seq);
  for (let i = 15; i >= 0 && n > 0n; i -= 1) {
    iv[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return iv;
}

/** Parse `0x...` hex into a 16-byte, left-padded IV. */
export function parseHexIV(str) {
  let hex = String(str).trim().replace(/^0x/i, '');
  if (hex.length % 2) hex = `0${hex}`;
  const bytes = new Uint8Array(16);
  const raw = hex.match(/../g) || [];
  const src = raw.slice(-16).map((h) => parseInt(h, 16));
  bytes.set(src, 16 - src.length);
  return bytes;
}

function keyIsDrm(attrs) {
  const method = (attrs.METHOD || '').toUpperCase();
  const fmt = (attrs.KEYFORMAT || 'identity').toLowerCase();
  if (method === 'NONE') return null;
  if (method.startsWith('SAMPLE-AES')) return `METHOD=${method}`;
  if (fmt !== 'identity' && DRM_KEYFORMATS.some((d) => fmt === d.toLowerCase())) return `KEYFORMAT=${attrs.KEYFORMAT}`;
  if (fmt !== 'identity') return `KEYFORMAT=${attrs.KEYFORMAT}`;
  if ((attrs.URI || '').startsWith('skd://')) return 'skd:// key';
  return null;
}

function parseResolution(res) {
  const m = /^(\d+)x(\d+)$/i.exec(res || '');
  return m ? { width: Number(m[1]), height: Number(m[2]) } : { width: 0, height: 0 };
}

function parseByteRange(spec, lastEnd) {
  const [len, off] = String(spec).split('@');
  const length = Number(len);
  const offset = off !== undefined ? Number(off) : lastEnd;
  return { offset, length };
}

/**
 * Parse a master playlist.
 * @returns {{variants: object[], audio: object[], subtitles: object[], drm: boolean, drmReason: string|null}}
 */
export function parseMaster(text, baseUrl) {
  const ls = lines(text);
  const variants = [];
  const audio = [];
  const subtitles = [];
  let drmReason = null;
  for (let i = 0; i < ls.length; i += 1) {
    const l = ls[i];
    if (l.startsWith('#EXT-X-STREAM-INF:')) {
      const a = parseAttributeList(l.slice(18));
      let uri = null;
      for (let j = i + 1; j < ls.length; j += 1) {
        if (!ls[j].startsWith('#')) { uri = ls[j]; i = j; break; }
      }
      if (!uri) continue;
      const { width, height } = parseResolution(a.RESOLUTION);
      variants.push({
        uri: resolveUrl(uri, baseUrl),
        bandwidth: Number(a.BANDWIDTH || 0),
        averageBandwidth: Number(a['AVERAGE-BANDWIDTH'] || 0),
        width,
        height,
        codecs: a.CODECS || '',
        frameRate: Number(a['FRAME-RATE'] || 0),
        audioGroup: a.AUDIO || null,
        subtitlesGroup: a.SUBTITLES || null,
        name: a.NAME || null,
      });
    } else if (l.startsWith('#EXT-X-MEDIA:')) {
      const a = parseAttributeList(l.slice(13));
      const r = {
        type: a.TYPE,
        groupId: a['GROUP-ID'] || '',
        name: a.NAME || a.LANGUAGE || '',
        language: a.LANGUAGE || '',
        uri: a.URI ? resolveUrl(a.URI, baseUrl) : null,
        default: a.DEFAULT === 'YES',
        autoselect: a.AUTOSELECT === 'YES',
        forced: a.FORCED === 'YES',
        channels: a.CHANNELS || '',
      };
      if (a.TYPE === 'AUDIO') audio.push(r);
      else if (a.TYPE === 'SUBTITLES') subtitles.push(r);
    } else if (l.startsWith('#EXT-X-SESSION-KEY:')) {
      const reason = keyIsDrm(parseAttributeList(l.slice(19)));
      if (reason) drmReason = reason;
    }
  }
  variants.sort((a, b) => (b.height - a.height) || (b.bandwidth - a.bandwidth));
  return { variants, audio, subtitles, drm: Boolean(drmReason), drmReason };
}

/**
 * Parse a media playlist into absolute segments.
 * Each segment: {uri, duration, seq, byteRange, key, map, discontinuity}.
 */
export function parseMedia(text, baseUrl) {
  const ls = lines(text);
  const segments = [];
  let targetDuration = 0;
  let mediaSequence = 0;
  let endList = false;
  let playlistType = null;
  let key = null;
  let map = null;
  let pendingDuration = null;
  let pendingTitle = '';
  let pendingRange = null;
  let pendingDisc = false;
  let drmReason = null;
  const lastEndByUri = new Map();
  let seq = 0;
  let seqInit = false;

  for (const l of ls) {
    if (l.startsWith('#EXT-X-TARGETDURATION:')) targetDuration = Number(l.slice(22));
    else if (l.startsWith('#EXT-X-MEDIA-SEQUENCE:')) { mediaSequence = Number(l.slice(22)); seq = mediaSequence; seqInit = true; }
    else if (l.startsWith('#EXT-X-ENDLIST')) endList = true;
    else if (l.startsWith('#EXT-X-PLAYLIST-TYPE:')) playlistType = l.slice(21).trim();
    else if (l.startsWith('#EXT-X-KEY:')) {
      const a = parseAttributeList(l.slice(11));
      const reason = keyIsDrm(a);
      if (reason) drmReason = reason;
      if ((a.METHOD || '').toUpperCase() === 'NONE') key = null;
      else {
        key = {
          method: (a.METHOD || '').toUpperCase(),
          uri: a.URI ? resolveUrl(a.URI, baseUrl) : null,
          iv: a.IV ? parseHexIV(a.IV) : null,
          keyformat: a.KEYFORMAT || 'identity',
        };
      }
    } else if (l.startsWith('#EXT-X-MAP:')) {
      const a = parseAttributeList(l.slice(11));
      map = { uri: resolveUrl(a.URI, baseUrl), byteRange: a.BYTERANGE ? parseByteRange(a.BYTERANGE, 0) : null };
    } else if (l.startsWith('#EXTINF:')) {
      const body = l.slice(8);
      const comma = body.indexOf(',');
      pendingDuration = Number(comma >= 0 ? body.slice(0, comma) : body);
      pendingTitle = comma >= 0 ? body.slice(comma + 1) : '';
    } else if (l.startsWith('#EXT-X-BYTERANGE:')) {
      pendingRange = l.slice(17).trim();
    } else if (l.startsWith('#EXT-X-DISCONTINUITY') && !l.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE')) {
      pendingDisc = true;
    } else if (!l.startsWith('#')) {
      if (!seqInit) { seq = mediaSequence; seqInit = true; }
      const uri = resolveUrl(l, baseUrl);
      let byteRange = null;
      if (pendingRange) {
        byteRange = parseByteRange(pendingRange, lastEndByUri.get(uri) || 0);
        lastEndByUri.set(uri, byteRange.offset + byteRange.length);
      }
      segments.push({
        uri,
        duration: pendingDuration ?? 0,
        title: pendingTitle,
        seq,
        byteRange,
        key: key ? { ...key } : null,
        map,
        discontinuity: pendingDisc,
      });
      seq += 1;
      pendingDuration = null; pendingTitle = ''; pendingRange = null; pendingDisc = false;
    }
  }
  const totalDuration = Math.round(segments.reduce((s, x) => s + x.duration, 0) * 1000) / 1000;
  return {
    targetDuration,
    mediaSequence,
    endList,
    playlistType,
    live: !endList && playlistType !== 'VOD',
    segments,
    totalDuration,
    drm: Boolean(drmReason),
    drmReason,
    isFmp4: segments.some((s) => s.map),
  };
}
