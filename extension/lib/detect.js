/**
 * Classify a network response as downloadable media. Pure; used by the
 * service worker's webRequest listener.
 */

const VIDEO_EXT = new Set(['mp4', 'm4v', 'webm', 'mov', 'mkv', 'flv', 'avi', 'ogv', '3gp']);
const AUDIO_EXT = new Set(['mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac', 'wav', 'weba']);
const SEGMENT_EXT = new Set(['ts', 'm4s', 'cmfv', 'cmfa', 'mts', 'm2ts', 'aacp']);
const SUB_EXT = new Set(['vtt', 'srt', 'ttml', 'dfxp']);
const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp', 'svg']);

/** Lower-case file extension of a URL path ('' when none). */
export function extFromUrl(url) {
  let path;
  try { path = new URL(url).pathname; } catch { path = String(url).split(/[?#]/)[0]; }
  const last = path.split('/').pop() || '';
  const dot = last.lastIndexOf('.');
  return dot > 0 ? last.slice(dot + 1).toLowerCase() : '';
}

/**
 * @param {{url:string, contentType?:string, contentLength?:number}} r
 * @param {{minMediaBytes?:number}} [opts]
 * @returns {{kind: 'hls'|'dash'|'video'|'audio'|'segment'|'subtitle'|'image'|null, ext: string, mime: string}}
 */
export function classify(r, opts = {}) {
  const minMediaBytes = opts.minMediaBytes ?? 0;
  const mime = String(r.contentType || '').split(';')[0].trim().toLowerCase();
  const ext = extFromUrl(r.url);
  const len = Number.isFinite(r.contentLength) ? r.contentLength : -1;
  const res = (kind) => ({ kind, ext, mime });

  if (/mpegurl/.test(mime) || ext === 'm3u8') return res('hls');
  if (mime === 'application/dash+xml' || ext === 'mpd') return res('dash');
  if (mime === 'video/mp2t' || mime === 'video/iso.segment' || mime === 'audio/iso.segment' || SEGMENT_EXT.has(ext)) return res('segment');
  if (mime === 'text/vtt' || mime === 'application/x-subrip' || SUB_EXT.has(ext)) return res('subtitle');

  let kind = null;
  if (mime.startsWith('video/')) kind = 'video';
  else if (mime.startsWith('audio/')) kind = 'audio';
  else if (VIDEO_EXT.has(ext) && (mime === '' || mime === 'application/octet-stream' || mime === 'binary/octet-stream')) kind = 'video';
  else if (AUDIO_EXT.has(ext) && (mime === '' || mime === 'application/octet-stream' || mime === 'binary/octet-stream')) kind = 'audio';
  else if (mime.startsWith('image/') || IMAGE_EXT.has(ext)) return res('image');
  if (!kind) return res(null);
  if (len >= 0 && len < minMediaBytes) return res(null);
  return res(kind);
}

/** Best guess of a file extension for a media response. */
export function mediaExt(kind, ext, mime) {
  if (ext && (VIDEO_EXT.has(ext) || AUDIO_EXT.has(ext))) return ext;
  const map = {
    'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'video/x-matroska': 'mkv', 'video/x-flv': 'flv',
    'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/ogg': 'ogg', 'audio/webm': 'weba', 'audio/flac': 'flac', 'audio/wav': 'wav', 'audio/x-wav': 'wav',
  };
  return map[mime] || (kind === 'audio' ? 'mp3' : 'mp4');
}
