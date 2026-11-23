// api/_html.js — reading HTML with plain code: no DOM, no network, no clock.
// Shared by the rubric (./_rubric.js) and the crawler (./_crawl.js) so both
// read a page the same way. Underscore prefix: not a route.
//
// Regex reading is good enough for "is there a tel: link" and "what words can a
// visitor read"; it is never used to decide anything about safety (the fetch
// rules in ./_audit-net.js do that).

const ENTITY = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", '#x27': "'", apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', mdash: '—', ndash: '–', hellip: '…' };
export const decode = s => String(s).replace(/&(amp|lt|gt|quot|#39|#x27|apos|nbsp|rsquo|lsquo|ldquo|rdquo|mdash|ndash|hellip);/gi, (m, e) => ENTITY[e.toLowerCase()])
  .replace(/&#(\d{2,6});/g, (m, n) => { const c = Number(n); return c > 31 && c < 0x10ffff ? String.fromCodePoint(c) : ' '; });

/** Comments, scripts, styles, templates and inline SVG removed: what is left is
 *  what a visitor can read and the tags around it. */
export const strip = html => String(html || '').replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style|noscript|template|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');

export const textOf = html => decode(String(html).replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|h[1-6]|li|section|header|footer|tr|button|a)\s*>/gi, ' \n').replace(/<[^>]*>/g, ' ')).replace(/[ \t\f\v\r]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();

export function attrsOf(tag) {
  const out = {}, re = /([a-zA-Z_:][-\w:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m; while ((m = re.exec(tag))) out[m[1].toLowerCase()] = decode(m[2] ?? m[3] ?? m[4] ?? '');
  return out;
}
export const openTags = (html, name) => [...String(html).matchAll(new RegExp(`<${name}\\b([^>]*)>`, 'gi'))].map(m => ({ a: attrsOf(m[1]), at: m.index }));
export const pairs = (html, name) => [...String(html).matchAll(new RegExp(`<${name}\\b([^>]*)>([\\s\\S]*?)<\\/${name}\\s*>`, 'gi'))].map(m => ({ a: attrsOf(m[1]), inner: m[2], at: m.index }));

/** The body of a page with comments and scripts removed. */
export function bodyOf(rawHtml) {
  const html = strip(rawHtml);
  const m = /<body\b[^>]*>([\s\S]*)/i.exec(html);
  return m ? m[1] : html;
}

/** The words a visitor can read on a page: tags, scripts, styles and comments
 *  removed, entities decoded, capped. This is what Claude reads and what every
 *  quote is checked against. */
export const TEXT_CAP = 12000;
export const visibleText = (rawHtml, cap = TEXT_CAP) => textOf(bodyOf(rawHtml)).slice(0, cap);

/** Quote matching ignores case, spacing, curly quotes and dashes, and nothing else. */
export const normalize = s => String(s || '').toLowerCase().replace(/[‘’ʼ`]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/…/g, '...').replace(/\s+/g, ' ').trim();

export const titleOf = rawHtml => { const t = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(strip(rawHtml)); return t ? textOf(t[1]) : ''; };
export const wordCount = text => (String(text).match(/[A-Za-z0-9][A-Za-z0-9'’-]*/g) || []).length;
