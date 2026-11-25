import { DEFAULTS, loadSettings, saveSettings } from './lib/settings.js';

const $ = (s) => document.querySelector(s);
const NUM = ['concurrency', 'maxRetries', 'minMediaKB', 'minImagePx', 'maxLength'];
const BOOL = ['useHelper', 'keepIntermediate', 'embedSubtitles', 'history'];
const STR = ['template', 'folder', 'subtitleFormat'];

async function load() {
  const s = await loadSettings();
  for (const k of NUM) $(`#${k}`).value = s[k];
  for (const k of BOOL) $(`#${k}`).checked = Boolean(s[k]);
  for (const k of STR) $(`#${k}`).value = s[k];
}

async function checkHelper() {
  const st = $('#h-status');
  st.textContent = '확인 중…'; st.className = 'status';
  const r = await chrome.runtime.sendMessage({ target: 'sw', type: 'helperCheck' }).catch(() => null);
  const h = r && r.helper;
  if (h) {
    st.textContent = `연결됨 — ffmpeg ${h.ffmpegVersion || ''} (${h.ffmpeg})`;
    st.className = 'status ok';
    $('#h-install').hidden = true;
  } else {
    st.textContent = '연결 안 됨';
    st.className = 'status off';
    $('#h-install').hidden = false;
  }
}

$('#save').addEventListener('click', async () => {
  const patch = {};
  for (const k of NUM) {
    const v = Number($(`#${k}`).value);
    patch[k] = Number.isFinite(v) && v >= 0 ? v : DEFAULTS[k];
  }
  patch.concurrency = Math.min(16, Math.max(1, patch.concurrency));
  patch.maxRetries = Math.min(10, Math.max(1, patch.maxRetries));
  for (const k of BOOL) patch[k] = $(`#${k}`).checked;
  for (const k of STR) patch[k] = $(`#${k}`).value.trim();
  if (!patch.template) patch.template = DEFAULTS.template;
  await saveSettings(patch);
  const s = $('#saved');
  s.hidden = false;
  setTimeout(() => { s.hidden = true; }, 1800);
});
$('#h-check').addEventListener('click', checkHelper);

load();
checkHelper();
