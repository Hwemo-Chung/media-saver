/**
 * Minimal, DOM-free XML parser good enough for DASH MPDs.
 * Element: {name (local name), qname, attrs (local names), children, text}.
 */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function localName(q) {
  const i = q.indexOf(':');
  return i >= 0 ? q.slice(i + 1) : q;
}

/**
 * @param {string} text
 * @returns {{name:string,qname:string,attrs:Record<string,string>,children:object[],text:string}}
 */
export function parseXml(text) {
  const src = String(text);
  const root = { name: '#document', qname: '#document', attrs: {}, children: [], text: '' };
  const stack = [root];
  let i = 0;
  const top = () => stack[stack.length - 1];
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) { top().text += decodeEntities(src.slice(i)); break; }
    if (lt > i) top().text += decodeEntities(src.slice(i, lt));
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      i = end < 0 ? src.length : end + 3;
    } else if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9);
      top().text += src.slice(lt + 9, end < 0 ? src.length : end);
      i = end < 0 ? src.length : end + 3;
    } else if (src.startsWith('<?', lt)) {
      const end = src.indexOf('?>', lt + 2);
      i = end < 0 ? src.length : end + 2;
    } else if (src.startsWith('<!', lt)) {
      const end = src.indexOf('>', lt + 2);
      i = end < 0 ? src.length : end + 1;
    } else if (src[lt + 1] === '/') {
      const end = src.indexOf('>', lt);
      const qname = src.slice(lt + 2, end).trim();
      // pop to the matching element (tolerates minor nesting errors)
      for (let k = stack.length - 1; k > 0; k -= 1) {
        if (stack[k].qname === qname) { stack.length = k; break; }
      }
      i = end < 0 ? src.length : end + 1;
    } else {
      // start tag: find '>' not inside quotes
      let j = lt + 1; let quote = null;
      for (; j < src.length; j += 1) {
        const c = src[j];
        if (quote) { if (c === quote) quote = null; } else if (c === '"' || c === "'") quote = c; else if (c === '>') break;
      }
      let body = src.slice(lt + 1, j);
      const selfClosing = body.endsWith('/');
      if (selfClosing) body = body.slice(0, -1);
      const nm = /^([^\s/>]+)/.exec(body);
      const qname = nm ? nm[1] : '';
      const attrs = {};
      const re = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
      let m;
      const rest = body.slice(qname.length);
      while ((m = re.exec(rest)) !== null) {
        const an = m[1];
        if (an === 'xmlns' || an.startsWith('xmlns:')) continue;
        attrs[localName(an)] = decodeEntities(m[3] ?? m[4] ?? '');
      }
      const el = { name: localName(qname), qname, attrs, children: [], text: '' };
      top().children.push(el);
      if (!selfClosing) stack.push(el);
      i = j + 1;
    }
  }
  const trimText = (el) => { el.text = el.text.trim(); el.children.forEach(trimText); };
  trimText(root);
  const first = root.children[0];
  if (!first) throw new Error('XML: no root element');
  return first;
}

/** Direct children with the given local name. */
export function kids(el, name) {
  return el ? el.children.filter((c) => c.name === name) : [];
}

export function kid(el, name) {
  return kids(el, name)[0] || null;
}
