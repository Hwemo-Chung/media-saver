/**
 * Page scanner injected with chrome.scripting.executeScript({func: scanPage}).
 * It must stay self-contained (no imports, no outer variables) because Chrome
 * serializes the function source into the page.
 * Returns images and media elements found in the DOM, including lazy-load
 * attributes, srcset candidates, CSS backgrounds, links to images and og: tags.
 */
export function scanPage() {
  const images = new Map();
  const media = [];
  const abs = (u) => { try { return new URL(u, document.baseURI).href; } catch { return null; } };
  const add = (url, w, h, source, alt) => {
    const u = abs(url);
    if (!u || u.startsWith('blob:') || u.startsWith('about:') || u.startsWith('javascript:')) return;
    if (u.startsWith('data:') && (!u.startsWith('data:image/') || u.length > 8_000_000)) return;
    const prev = images.get(u);
    if (prev) { prev.w = Math.max(prev.w, w || 0); prev.h = Math.max(prev.h, h || 0); return; }
    images.set(u, { url: u, w: w || 0, h: h || 0, source, alt: (alt || '').slice(0, 120) });
  };
  const bestFromSrcset = (srcset) => {
    if (!srcset) return null;
    let best = null; let bestScore = -1;
    for (const part of srcset.split(/,\s+(?=\S)/)) {
      const [u, d] = part.trim().split(/\s+/);
      if (!u) continue;
      const score = d ? parseFloat(d) * (d.endsWith('x') ? 1000 : 1) : 1;
      if (score > bestScore) { bestScore = score; best = u; }
    }
    return best;
  };
  const LAZY = ['data-src', 'data-lazy-src', 'data-original', 'data-lazy', 'data-url', 'data-hi-res-src', 'data-full'];

  for (const img of document.images) {
    add(img.currentSrc || img.src, img.naturalWidth, img.naturalHeight, 'img', img.alt);
    const big = bestFromSrcset(img.getAttribute('srcset') || img.getAttribute('data-srcset'));
    if (big) add(big, 0, 0, 'srcset', img.alt);
    for (const a of LAZY) { const v = img.getAttribute(a); if (v && !v.startsWith('{')) add(v, 0, 0, 'lazy', img.alt); }
  }
  for (const s of document.querySelectorAll('picture source[srcset]')) {
    const big = bestFromSrcset(s.getAttribute('srcset'));
    if (big) add(big, 0, 0, 'picture');
  }
  for (const a of document.querySelectorAll('a[href]')) {
    if (/\.(jpe?g|png|gif|webp|avif|bmp)(\?|#|$)/i.test(a.getAttribute('href'))) add(a.href, 0, 0, 'link', a.textContent);
  }
  for (const m of document.querySelectorAll('meta[property="og:image"],meta[name="twitter:image"],meta[property="og:image:secure_url"]')) {
    if (m.content) add(m.content, 0, 0, 'meta');
  }
  let count = 0;
  for (const el of document.querySelectorAll('body *')) {
    if (count++ > 6000) break;
    const bg = getComputedStyle(el).backgroundImage;
    if (bg && bg !== 'none') {
      for (const m of bg.matchAll(/url\(["']?([^"')]+)["']?\)/g)) add(m[1], 0, 0, 'css');
    }
  }

  for (const v of document.querySelectorAll('video, audio')) {
    const kind = v.tagName.toLowerCase() === 'video' ? 'video' : 'audio';
    const srcs = [v.currentSrc, v.src, ...Array.from(v.querySelectorAll('source')).map((s) => s.src)];
    for (const s of srcs) {
      const u = s && abs(s);
      if (u && /^https?:/.test(u)) media.push({ url: u, kind, duration: Number.isFinite(v.duration) ? v.duration : 0, poster: v.poster || '' });
    }
  }
  for (const m of document.querySelectorAll('meta[property="og:video"],meta[property="og:video:url"],meta[property="og:video:secure_url"],meta[property="og:audio"]')) {
    const u = m.content && abs(m.content);
    if (u && /^https?:/.test(u)) media.push({ url: u, kind: m.getAttribute('property').includes('audio') ? 'audio' : 'video', duration: 0, poster: '' });
  }
  const ogTitle = document.querySelector('meta[property="og:title"]');
  return {
    pageUrl: location.href,
    title: (ogTitle && ogTitle.content) || document.title || '',
    images: Array.from(images.values()),
    media,
  };
}
