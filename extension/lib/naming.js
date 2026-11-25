/**
 * File-name templating. Variables: %title %hostname %quality %date %ext-less.
 */

/** Make a string safe as a single macOS/Windows file-name component. */
export function sanitize(s) {
  let out = String(s ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '');
  if (!out) out = 'media';
  return out;
}

function pad(n, w = 2) { return String(n).padStart(w, '0'); }

/** Cut by code points so Korean/emoji are never split in half. */
function cut(s, max) {
  const cps = Array.from(s);
  return cps.length > max ? cps.slice(0, max).join('').trim() : s;
}

/**
 * @param {{template?:string,title?:string,hostname?:string,quality?:string,ext:string,maxLength?:number,now?:Date}} o
 * @returns {string} file name with extension
 */
export function buildFilename(o) {
  const template = o.template || '%title';
  const now = o.now || new Date();
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const host = String(o.hostname || '').replace(/^www\./, '');
  let name = template
    .replace(/%title/g, o.title || '')
    .replace(/%hostname/g, host)
    .replace(/%quality/g, o.quality || '')
    .replace(/%date/g, date);
  // drop dangling separators left by empty variables (e.g. "T - " when quality is empty)
  name = name.replace(/(\s*[-_–·]\s*)+$/g, '').replace(/^(\s*[-_–·]\s*)+/g, '').replace(/\s*-\s*-\s*/g, ' - ');
  name = sanitize(name);
  name = cut(name, o.maxLength || 100);
  name = sanitize(name);
  const ext = String(o.ext || '').replace(/^\./, '');
  return ext ? `${name}.${ext}` : name;
}

/** Join an optional sub-folder (relative to Downloads) and a file name for chrome.downloads. */
export function downloadPath(folder, filename) {
  const parts = String(folder || '').split('/').map((p) => p.trim()).filter(Boolean).map(sanitize);
  return [...parts, filename].join('/');
}
