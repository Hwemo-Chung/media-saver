/** User settings with defaults, stored in chrome.storage.local. */

export const DEFAULTS = Object.freeze({
  concurrency: 6, // parallel segment downloads per job
  template: '%title - %quality', // file-name template
  maxLength: 100, // max file-name length (characters)
  folder: 'Media Saver', // sub-folder inside the Downloads folder ('' = Downloads itself)
  minMediaKB: 100, // ignore direct media files smaller than this
  minImagePx: 200, // Images tab default: hide images whose shorter side is below this
  subtitleFormat: 'srt', // 'srt' | 'vtt' | 'both'
  embedSubtitles: false, // also put subtitles inside the mp4 (needs the helper)
  useHelper: true, // use the local ffmpeg helper when it is installed
  keepIntermediate: false, // keep .ts / separate tracks after the helper merged them
  history: true, // keep a download history
  maxRetries: 4, // per-segment retries
});

export async function loadSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULTS, ...(settings || {}) };
}

export async function saveSettings(patch) {
  const cur = await loadSettings();
  const next = { ...cur, ...patch };
  for (const k of Object.keys(next)) if (!(k in DEFAULTS)) delete next[k];
  await chrome.storage.local.set({ settings: next });
  return next;
}
