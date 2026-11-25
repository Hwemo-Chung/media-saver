import { formatBytes, formatDuration } from './lib/plan.js';

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
const asTab = params.has('tab');
if (asTab) document.body.classList.add('as-tab');

const send = async (type, extra = {}) => {
  const r = await chrome.runtime.sendMessage({ target: 'sw', type, ...extra });
  if (!r || !r.ok) throw new Error((r && r.error) || '확장 오류');
  return r;
};

let tabId = Number(params.get('tab')) || null;
let current = { items: [], jobs: [], history: [], settings: {}, helper: null };
let images = []; // {url, w, h, ok, measured}
const selectedImages = new Set();
const chosen = new Map(); // itemId -> {optionId, subs:Set}
let imagesScanned = false;

const KIND = { hls: 'HLS', dash: 'DASH', video: 'VIDEO', audio: 'AUDIO', live: 'LIVE', images: 'IMG' };
const STATUS = {
  queued: '대기', downloading: '받는 중', recording: '녹화 중', saving: '파일 쓰는 중', processing: 'ffmpeg 처리 중',
  done: '완료', error: '오류', cancelled: '취소됨',
};
const ACTIVE = new Set(['queued', 'downloading', 'recording', 'saving', 'processing']);

function el(tpl) { return document.importNode($(tpl).content, true).firstElementChild; }
function base(p) { return String(p || '').split('/').pop(); }
function host(u) { try { return new URL(u).hostname; } catch { return ''; } }

// ------------------------------------------------------------ tabs
for (const b of document.querySelectorAll('.tab')) {
  b.addEventListener('click', () => showTab(b.dataset.tab));
}
function showTab(name) {
  for (const b of document.querySelectorAll('.tab')) {
    const on = b.dataset.tab === name;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
  }
  for (const p of document.querySelectorAll('.panel')) p.hidden = p.id !== `panel-${name}`;
  try { localStorage.setItem('ms-tab', name); } catch { /* ignore */ }
}

// ------------------------------------------------------------ media
let mediaSig = '';
function renderMedia() {
  // Re-render only when the detected items changed, so an open <select> is not torn down.
  const sig = JSON.stringify([current.title, current.items]);
  if (sig === mediaSig) return;
  mediaSig = sig;
  const list = $('#media-list');
  list.textContent = '';
  const items = current.items;
  $('#n-media').textContent = items.length;
  $('#media-empty').hidden = items.length > 0;
  for (const it of items) {
    const card = el('#tpl-media');
    const badge = card.querySelector('.badge');
    badge.textContent = it.drm ? 'DRM' : (it.live ? 'LIVE' : (KIND[it.kind] || it.kind.toUpperCase()));
    if (it.drm) badge.classList.add('drm'); else if (it.live) badge.classList.add('live');
    card.querySelector('.title').textContent = current.title || base(it.url) || '미디어';
    card.querySelector('.title').title = it.url;
    card.querySelector('.dur').textContent = it.live ? '실시간' : formatDuration(it.duration);
    card.querySelector('.src').textContent = `${host(it.url)} · ${base(it.url).split('?')[0].slice(0, 60)}`;
    const sel = card.querySelector('.quality');
    const pick = chosen.get(it.id) || { optionId: null, subs: new Set() };
    chosen.set(it.id, pick);
    for (const o of it.options) {
      const op = document.createElement('option');
      op.value = o.id;
      op.textContent = o.label;
      sel.append(op);
    }
    if (pick.optionId && it.options.some((o) => o.id === pick.optionId)) sel.value = pick.optionId;
    else if (it.options[0]) pick.optionId = it.options[0].id;
    sel.hidden = it.options.length <= 1;
    const sizeEl = card.querySelector('.size');
    const updateSize = () => {
      const o = it.options.find((x) => x.id === sel.value) || it.options[0];
      const est = o && o.estBytes ? o.estBytes : it.size;
      sizeEl.textContent = est ? `${it.options.length > 1 || it.kind === 'hls' || it.kind === 'dash' ? '약 ' : ''}${formatBytes(est)}` : '';
      if (it.options.length <= 1 && o) sizeEl.textContent = `${o.label}${sizeEl.textContent ? ` · ${sizeEl.textContent}` : ''}`;
    };
    sel.addEventListener('change', () => { pick.optionId = sel.value; updateSize(); });
    updateSize();

    if (it.subtitles && it.subtitles.length) {
      const box = card.querySelector('.subs');
      box.hidden = false;
      for (const s of it.subtitles) {
        const lab = document.createElement('label');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = pick.subs.has(s.id);
        cb.addEventListener('change', () => { if (cb.checked) pick.subs.add(s.id); else pick.subs.delete(s.id); });
        lab.append(cb, document.createTextNode(s.label));
        box.append(lab);
      }
    }

    const msg = card.querySelector('.msg');
    const save = card.querySelector('.save');
    if (it.live) { save.textContent = '녹화'; save.classList.add('rec'); }
    if (it.status === 'probing') { save.disabled = true; msg.textContent = '목록을 읽는 중…'; }
    if (it.status === 'error') { save.disabled = true; msg.textContent = it.error; msg.classList.add('err'); }
    if (it.drm) { save.disabled = true; msg.textContent = `보호된(DRM) 콘텐츠라 저장할 수 없습니다. (${it.drmReason || '암호화'})`; msg.classList.add('err'); }
    if (it.note && !it.drm) { msg.textContent = it.note; msg.classList.add('warn'); }
    if (it.kind === 'dash' && it.live) save.disabled = true;
    save.addEventListener('click', async () => {
      save.disabled = true;
      try {
        await send('download', { tabId, itemId: it.id, optionId: sel.value || pick.optionId, subtitleIds: [...pick.subs] });
        showTab('jobs');
      } catch (e) {
        msg.textContent = e.message; msg.className = 'msg err';
      } finally { save.disabled = false; }
    });
    card.querySelector('.copy').addEventListener('click', async () => {
      await navigator.clipboard.writeText(it.url);
      msg.textContent = '주소를 복사했습니다.'; msg.className = 'msg';
    });
    list.append(card);
  }
}

// ------------------------------------------------------------ images
const minPx = () => Number($('#min-px').value) || 0;
const known = (im) => Math.max(im.w, im.mw || 0) > 0;
const passes = (im) => {
  const w = Math.max(im.w, im.mw || 0); const h = Math.max(im.h, im.mh || 0);
  if (!w || !h) return minPx() === 0 && im.failed;
  return Math.min(w, h) >= minPx();
};

function renderImages() {
  const grid = $('#image-grid');
  const visible = images.filter((im) => passes(im) || (!known(im) && !im.failed));
  $('#n-images').textContent = images.filter(passes).length;
  grid.textContent = '';
  for (const im of visible) {
    const d = document.createElement('div');
    d.className = 'thumb';
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
    img.alt = im.alt || '';
    img.src = im.url;
    img.addEventListener('load', () => {
      const changed = !im.mw;
      im.mw = img.naturalWidth; im.mh = img.naturalHeight;
      dim.textContent = `${im.mw}×${im.mh}`;
      if (changed) { if (passes(im)) selectedImages.add(im.url); else selectedImages.delete(im.url); scheduleImages(); }
    });
    img.addEventListener('error', () => { im.failed = true; dim.textContent = '미리보기 없음'; });
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = selectedImages.has(im.url);
    const dim = document.createElement('span');
    dim.className = 'dim';
    dim.textContent = known(im) ? `${Math.max(im.w, im.mw || 0)}×${Math.max(im.h, im.mh || 0)}` : '…';
    const toggle = (on) => { if (on) selectedImages.add(im.url); else selectedImages.delete(im.url); cb.checked = on; d.classList.toggle('sel', on); updateSaveBtn(); };
    d.classList.toggle('sel', cb.checked);
    cb.addEventListener('click', (e) => { e.stopPropagation(); toggle(cb.checked); });
    d.addEventListener('click', () => toggle(!selectedImages.has(im.url)));
    d.title = im.url.startsWith('data:') ? '(페이지 안에 들어 있는 이미지)' : im.url;
    d.append(img, cb, dim);
    grid.append(d);
  }
  $('#images-empty').hidden = visible.length > 0;
  updateSaveBtn();
}
let imgTimer = null;
function scheduleImages() { clearTimeout(imgTimer); imgTimer = setTimeout(renderImages, 150); }
function updateSaveBtn() {
  const urls = images.filter((im) => selectedImages.has(im.url) && passes(im)).map((im) => im.url);
  const b = $('#img-save');
  b.textContent = `저장 (${urls.length})`;
  b.disabled = urls.length === 0;
  return urls;
}
$('#min-px').addEventListener('input', () => {
  for (const im of images) { if (passes(im)) selectedImages.add(im.url); else selectedImages.delete(im.url); }
  renderImages();
});
$('#img-all').addEventListener('click', () => { for (const im of images) if (passes(im)) selectedImages.add(im.url); renderImages(); });
$('#img-none').addEventListener('click', () => { selectedImages.clear(); renderImages(); });
$('#img-save').addEventListener('click', async () => {
  const urls = updateSaveBtn();
  if (!urls.length) return;
  await send('downloadImages', { tabId, urls });
  showTab('jobs');
  refresh();
});

async function scan() {
  try {
    const r = await send('scan', { tabId });
    images = r.images.map((im) => ({ ...im }));
    for (const im of images) if (passes(im)) selectedImages.add(im.url);
    imagesScanned = true;
    renderImages();
  } catch (e) {
    $('#images-empty').hidden = false;
    $('#images-empty').textContent = e.message;
  }
}

// ------------------------------------------------------------ jobs
function renderJobs() {
  const list = $('#job-list');
  list.textContent = '';
  const jobs = current.jobs;
  $('#n-jobs').textContent = jobs.filter((j) => ACTIVE.has(j.status)).length;
  $('#jobs-empty').hidden = jobs.length > 0;
  for (const j of jobs) {
    const card = el('#tpl-job');
    card.classList.add(j.status);
    const badge = card.querySelector('.badge');
    badge.textContent = KIND[j.kind] || j.kind.toUpperCase();
    if (j.kind === 'live') badge.classList.add('live');
    card.querySelector('.title').textContent = j.title;
    card.querySelector('.status').textContent = STATUS[j.status] || j.status;
    const bar = card.querySelector('.bar');
    const fill = card.querySelector('.fill');
    if (j.status === 'recording' || (ACTIVE.has(j.status) && !j.progress && !j.segTotal)) bar.classList.add('indet');
    fill.style.width = `${Math.round((j.progress || 0) * 100)}%`;
    if (!ACTIVE.has(j.status)) bar.hidden = true;
    const parts = [];
    if (j.status === 'recording') parts.push(`녹화 ${formatDuration(j.recordedSec) || '0:00'}`);
    if (j.segTotal && j.kind !== 'images') parts.push(`조각 ${j.segDone}/${j.segTotal}`);
    if (j.kind === 'images') parts.push(`${j.segDone}/${j.segTotal}장`);
    if (j.bytes) parts.push(formatBytes(j.bytes) + (j.totalBytes ? ` / ${formatBytes(j.totalBytes)}` : ''));
    if (j.speed && ACTIVE.has(j.status) && j.status !== 'processing') parts.push(`${formatBytes(j.speed)}/s`);
    if (j.status === 'processing') parts.push(`영상·음성 합치기 ${Math.round((j.progress || 0) * 100)}%`);
    const detail = card.querySelector('.detail');
    detail.textContent = parts.join(' · ');
    if (j.error) { const e = document.createElement('div'); e.className = 'err'; e.textContent = j.error; detail.after(e); }
    if (j.note) { const n = document.createElement('div'); n.className = 'detail'; n.textContent = j.note; detail.after(n); }
    const outs = card.querySelector('.outputs');
    if (j.status === 'done' && j.outputs.length) {
      outs.textContent = j.kind === 'images' ? `${j.outputs.length}개 파일 → ${j.outputs[0].split('/').slice(-2, -1)[0]}/` : j.outputs.map(base).join('\n');
    }
    const stop = card.querySelector('.stop');
    const cancel = card.querySelector('.cancel');
    const reveal = card.querySelector('.reveal');
    const remove = card.querySelector('.remove');
    if (j.status === 'recording') { stop.hidden = false; stop.textContent = '녹화 끝내고 저장'; }
    if (ACTIVE.has(j.status) && j.status !== 'processing' && j.status !== 'saving') cancel.hidden = false;
    if (j.status === 'done' && j.outputs.length) reveal.hidden = false;
    if (!ACTIVE.has(j.status)) remove.hidden = false;
    stop.addEventListener('click', () => send('stopJob', { jobId: j.id, mode: 'stop' }).then(refresh));
    cancel.addEventListener('click', () => send('stopJob', { jobId: j.id, mode: 'cancel' }).then(refresh));
    reveal.addEventListener('click', () => {
      const f = (j.files || []).find((x) => x.path === j.outputs[0]);
      send('reveal', { path: j.outputs[0], downloadId: f ? f.downloadId : j.downloadId }).catch((e) => { detail.textContent = e.message; });
    });
    remove.addEventListener('click', () => send('removeJob', { jobId: j.id }).then(refresh));
    list.append(card);
  }
  const h = $('#history-list');
  h.textContent = '';
  $('#n-history').textContent = current.history.length ? `(${current.history.length})` : '';
  for (const it of current.history) {
    const row = document.createElement('div');
    row.className = 'h';
    const a = document.createElement('span'); a.textContent = it.title; a.title = (it.outputs || []).join('\n');
    const b = document.createElement('span'); b.textContent = new Date(it.finishedAt).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    row.append(a, b);
    h.append(row);
  }
}
$('#clear-done').addEventListener('click', () => send('clearFinished').then(refresh));
$('#open-folder').addEventListener('click', () => send('openFolder'));
$('#clear-history').addEventListener('click', () => send('clearHistory').then(refresh));

// ------------------------------------------------------------ helper + settings
function renderHelper() {
  const c = $('#helper');
  if (!current.settings.useHelper) { c.textContent = '도우미 꺼짐'; c.className = 'chip off'; return; }
  if (current.helper) { c.textContent = `ffmpeg 연결됨`; c.title = `${current.helper.ffmpeg} (${current.helper.ffmpegVersion || ''})`; c.className = 'chip ok'; }
  else if (current.helperChecked) { c.textContent = '도우미 없음'; c.title = 'HLS는 .ts, DASH는 영상·음성 두 파일로 저장됩니다. 설정에서 설치 방법을 보십시오.'; c.className = 'chip off'; }
}
$('#settings').addEventListener('click', () => chrome.runtime.openOptionsPage());

// ------------------------------------------------------------ refresh loop
let refreshing = false;
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    current = await send('getState', { tabId });
    renderMedia();
    renderJobs();
    renderHelper();
    if (!imagesScanned) $('#min-px').value = current.settings.minImagePx;
  } finally { refreshing = false; }
}

(async () => {
  // Development only: reload the extension when the local dev token exists.
  if (params.get('panel') === 'dev-reload') {
    const r = await fetch(chrome.runtime.getURL('dev-token.txt'), { cache: 'no-store' }).catch(() => null);
    if (r && r.ok) { chrome.runtime.reload(); return; }
  }
  if (!tabId) {
    const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = t ? t.id : null;
  }
  let saved = null;
  try { saved = localStorage.getItem('ms-tab'); } catch { /* ignore */ }
  if (params.get('panel')) saved = params.get('panel');
  if (saved) showTab(saved);
  const port = chrome.runtime.connect({ name: 'popup' });
  port.onMessage.addListener((m) => { if (m.type === 'changed') refresh(); });
  await refresh();
  if (!current.helperChecked) send('helperCheck').then(refresh).catch(() => {});
  await scan();
  await refresh();
  setInterval(() => { if (current.jobs.some((j) => ACTIVE.has(j.status))) refresh(); }, 1000);
})();
