/**
 * Segment download engine shared by the offscreen document and Node tests.
 * All IO is injected: fetchText(url, signal), fetchBytes(url, range, signal),
 * write(Uint8Array). Nothing here touches chrome.* or the DOM.
 */
import { parseMaster, parseMedia, isMasterPlaylist, ivForSequence } from './hls.js';
import { decryptAes128 } from './aes.js';
import { OrderedSink, runPool } from './ordered.js';

export const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal && signal.aborted) { reject(new Error('aborted')); return; }
  const t = setTimeout(resolve, ms);
  if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
});

export function concat(a, b) {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0); out.set(b, a.byteLength);
  return out;
}

/** Resolve a (possibly master) playlist URI to a parsed media playlist. */
export async function loadMediaPlaylist(uri, fetchText, signal) {
  const text = await fetchText(uri, signal);
  if (isMasterPlaylist(text)) {
    const m = parseMaster(text, uri);
    if (!m.variants.length) throw new Error('재생 목록에 화질이 없습니다');
    return loadMediaPlaylist(m.variants[0].uri, fetchText, signal);
  }
  return { uri, pl: parseMedia(text, uri) };
}

/** File extension for an HLS track's concatenated segments. */
export function hlsTrackExt(pl, role) {
  if (pl.isFmp4) return role === 'audio' ? 'm4a' : 'mp4';
  const first = pl.segments[0] ? pl.segments[0].uri : '';
  if (/\.aac(\?|$)/i.test(first)) return 'aac';
  if (/\.mp3(\?|$)/i.test(first)) return 'mp3';
  return 'ts';
}

export function makeKeyLoader(fetchBytes, signal) {
  const cache = new Map();
  return (uri) => {
    if (!cache.has(uri)) {
      const p = fetchBytes(uri, null, signal).then((b) => {
        if (b.length !== 16) throw new Error(`AES 키 길이가 16바이트가 아닙니다(${b.length})`);
        return b;
      });
      p.catch(() => cache.delete(uri));
      cache.set(uri, p);
    }
    return cache.get(uri);
  };
}

export function makeInitLoader(fetchBytes, signal) {
  const cache = new Map();
  return (map) => {
    const k = mapKey(map);
    if (!cache.has(k)) {
      const p = fetchBytes(map.uri, map.byteRange, signal);
      p.catch(() => cache.delete(k));
      cache.set(k, p);
    }
    return cache.get(k);
  };
}

export function mapKey(map) {
  return map ? `${map.uri}|${map.byteRange ? `${map.byteRange.offset}+${map.byteRange.length}` : ''}` : '';
}

/** Fetch one HLS segment and decrypt it when it uses standard AES-128. */
export async function segmentBytes(seg, fetchBytes, getKey, signal) {
  let data = await fetchBytes(seg.uri, seg.byteRange, signal);
  if (seg.key && seg.key.method === 'AES-128') {
    const key = await getKey(seg.key.uri);
    data = await decryptAes128(data, key, seg.key.iv || ivForSequence(seg.seq));
  } else if (seg.key && seg.key.method !== 'NONE') {
    throw new Error(`지원하지 않는 암호화 방식: ${seg.key.method}`);
  }
  return data;
}

const PACKET = 188;
const SCAN_LIMIT = 64 * 1024;

/**
 * Offset of the first MPEG-TS packet: a 0x47 sync byte repeated every 188 bytes.
 * Some hosts prepend a fake image header to every segment; players skip it the
 * same way (hls.js scans ~940 bytes, we scan 64 KB). -1 when no TS is found.
 */
export function tsSyncOffset(data) {
  const len = data.length;
  const last = Math.min(len - PACKET, SCAN_LIMIT);
  for (let i = 0; i <= last; i += 1) {
    if (data[i] !== 0x47) continue;
    const following = Math.min(3, Math.floor((len - i - 1) / PACKET));
    let ok = true;
    for (let k = 1; k <= following && ok; k += 1) ok = data[i + k * PACKET] === 0x47;
    if (ok) return i;
  }
  return -1;
}

const BOXES = new Set(['ftyp', 'styp', 'moof', 'moov', 'sidx', 'emsg', 'prft', 'mdat']);

/** Short name for what a segment's bytes really are, for error messages. */
export function sniffSegment(data) {
  const b = data;
  const str = (from, n) => String.fromCharCode(...b.subarray(from, from + n));
  if (b.length >= 4 && b[0] === 0x89 && str(1, 3) === 'PNG') return 'PNG';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'JPEG';
  if (str(0, 4) === 'GIF8') return 'GIF';
  if (str(0, 4) === 'RIFF' && str(8, 4) === 'WEBP') return 'WEBP';
  if (str(0, 3) === 'ID3') return 'ID3';
  if (b.length >= 8 && BOXES.has(str(4, 4))) return 'fMP4';
  if (b[0] === 0x47) return 'MPEG-TS';
  if (b.length >= 2 && b[0] === 0xff && (b[1] & 0xf6) === 0xf0) return 'AAC(ADTS)';
  const head = str(0, 64).trimStart();
  if (head.startsWith('<')) return 'HTML';
  if (head.startsWith('{') || head.startsWith('[')) return 'JSON';
  return [...b.subarray(0, 8)].map((x) => x.toString(16).padStart(2, '0')).join(' ') || '빈 응답';
}

/** Return the MPEG-TS part of a segment (dropping a disguise header), or explain why there is none. */
export function cleanTsSegment(data, encrypted) {
  if (!data.length) return data;
  if (data[0] === 0x49 && data[1] === 0x44 && data[2] === 0x33) return data; // "ID3": packed audio
  const off = tsSyncOffset(data);
  if (off === 0) return data;
  if (off > 0) return data.subarray(off);
  if (encrypted) throw new Error('복호화 결과가 MPEG-TS가 아닙니다(키 또는 IV 불일치)');
  const kind = sniffSegment(data);
  const hint = kind === 'HTML' || kind === 'JSON' ? ' — 서버가 영상 대신 안내 문서를 보냈습니다(차단 또는 주소 만료)' : '';
  throw new Error(`조각 형식이 MPEG-TS가 아닙니다(받은 것: ${kind})${hint}`);
}

/**
 * Download a VOD HLS media playlist in order.
 * @param {{pl, fetchBytes, write, concurrency, retries, signal, onSegment?: (bytes:number)=>void}} o
 */
export async function downloadHlsTrack(o) {
  const { pl, fetchBytes, write, signal } = o;
  const ext = hlsTrackExt(pl, o.role || 'video');
  const getKey = makeKeyLoader(fetchBytes, signal);
  const getInit = makeInitLoader(fetchBytes, signal);
  const sink = new OrderedSink((chunk) => write(chunk));
  const segs = pl.segments;
  const windowSize = Math.max(8, o.concurrency * 4);
  await runPool(segs, o.concurrency, async (seg, i) => {
    while (i - sink.next > windowSize) await sleep(30, signal);
    let data = await segmentBytes(seg, fetchBytes, getKey, signal);
    if (ext === 'ts') data = cleanTsSegment(data, Boolean(seg.key));
    const prev = i > 0 ? segs[i - 1] : null;
    if (seg.map && (!prev || mapKey(prev.map) !== mapKey(seg.map))) data = concat(await getInit(seg.map), data);
    await sink.put(i, data);
    if (o.onSegment) o.onSegment(data.byteLength);
  }, { retries: o.retries, retryDelayMs: o.retryDelayMs ?? 700, signal });
  return { ext };
}

/**
 * Record a live HLS media playlist until shouldStop() or ENDLIST.
 * @returns {{gaps:number, segments:number, seconds:number}}
 */
export async function recordHlsLive(o) {
  const { uri, fetchText, fetchBytes, write, signal } = o;
  let pl = o.pl || parseMedia(await fetchText(uri, signal), uri);
  const getKey = makeKeyLoader(fetchBytes, signal);
  const getInit = makeInitLoader(fetchBytes, signal);
  const ext = hlsTrackExt(pl, o.role || 'video');
  let lastSeq = -1; let lastMap = ''; let gaps = 0; let segments = 0; let seconds = 0;
  const stop = () => (o.shouldStop && o.shouldStop()) || (signal && signal.aborted);
  while (!stop()) {
    const fresh = pl.segments.filter((s) => s.seq > lastSeq);
    if (lastSeq >= 0 && fresh.length && fresh[0].seq > lastSeq + 1) gaps += 1;
    for (const seg of fresh) {
      if (stop()) break;
      let data = null;
      for (let attempt = 1; attempt <= o.retries; attempt += 1) {
        try { data = await segmentBytes(seg, fetchBytes, getKey, signal); break; } catch (e) {
          if (signal && signal.aborted) throw e;
          if (attempt === o.retries) { gaps += 1; data = null; } else await sleep(500 * attempt, signal);
        }
      }
      lastSeq = seg.seq;
      if (!data) continue;
      if (ext === 'ts') data = cleanTsSegment(data, Boolean(seg.key));
      const k = mapKey(seg.map);
      if (seg.map && k !== lastMap) { data = concat(await getInit(seg.map), data); lastMap = k; }
      await write(data);
      segments += 1; seconds += seg.duration;
      if (o.onSegment) o.onSegment(data.byteLength, seconds);
    }
    if (pl.endList || stop()) break;
    const wait = Math.max(1000, Math.min(6000, (pl.targetDuration || 2) * 500));
    for (let waited = 0; waited < wait && !stop(); waited += 250) await sleep(250, signal);
    if (stop()) break;
    pl = parseMedia(await fetchText(uri, signal), uri);
  }
  if (signal && signal.aborted) throw new Error('aborted');
  return { gaps, segments, seconds };
}

/** Download one DASH representation (init + segments, or a whole single file via streamWhole). */
export async function downloadDashRep(o) {
  const { rep, fetchBytes, write, signal } = o;
  if (rep.single) {
    if (o.streamWhole) await o.streamWhole(rep.segments[0].url, write, signal);
    else await write(await fetchBytes(rep.segments[0].url, null, signal));
    if (o.onSegment) o.onSegment(0);
    return;
  }
  if (rep.init) await write(await fetchBytes(rep.init.url, rep.init.range, signal));
  const sink = new OrderedSink((chunk) => write(chunk));
  const windowSize = Math.max(8, o.concurrency * 4);
  await runPool(rep.segments, o.concurrency, async (seg, i) => {
    while (i - sink.next > windowSize) await sleep(30, signal);
    const data = await fetchBytes(seg.url, seg.range, signal);
    await sink.put(i, data);
    if (o.onSegment) o.onSegment(data.byteLength);
  }, { retries: o.retries, retryDelayMs: o.retryDelayMs ?? 700, signal });
}
