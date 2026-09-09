import createDOMPurify from 'dompurify';
import { marked } from 'marked';
import { safeUrl, type Bundle, type Mode } from './model';
const tags = [
  'p', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'strong', 'em', 'b', 'i', 's', 'del', 'ul', 'ol', 'li',
  'blockquote', 'pre', 'code', 'a', 'img', 'hr',
  'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'figure', 'figcaption', 'div', 'span', 'sup', 'sub', 'mark',
  'section', 'article', 'aside', 'header', 'footer'
];
export function articleFragment(bundle: Bundle, mode: Mode, doc: Document, images: boolean): DocumentFragment | null {
  let html: string;
  if (mode === 'rewrite') {
    if (!bundle.rewrite?.body.trim()) return null;
    html = marked.parse(bundle.rewrite.body, { async: false });
  } else if (mode === 'translation') {
    if (!bundle.translation?.content?.length) return null;
    html = bundle.translation.content.map(pair => {
      if (pair.target?.trim()) return `<p>${escapeHtml(pair.target)}</p>`;
      return pair.targetHtml || '';
    }).join('\n');
    if (!html.trim()) return null;
  } else {
    html = bundle.entry.content?.trim() || '';
    if (!html) return null;
  }
  const win = doc.defaultView;
  if (!win) throw new Error('阅读窗口不可用。');
  const fragment = createDOMPurify(win).sanitize(html, {
    RETURN_DOM_FRAGMENT: true, ALLOWED_TAGS: images ? tags : tags.filter(tag => tag !== 'img'),
    ALLOWED_ATTR: ['href', 'src', 'alt'], ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false,
  });

  // Convert leaf section, article and div elements to paragraphs so WeChat and RSS articles break into distinct paragraphs
  const blockTags = 'section, article, p, div, table, ul, ol, blockquote, pre, h1, h2, h3, h4, h5, h6, figure';
  for (const element of Array.from(fragment.querySelectorAll('section, article, div'))) {
    const hasBlock = element.querySelector(blockTags);
    if (!hasBlock && (element.textContent?.trim() || element.querySelector('img'))) {
      const p = doc.createElement('p');
      while (element.firstChild) p.appendChild(element.firstChild);
      element.replaceWith(p);
    }
  }

  // Remove empty paragraphs
  for (const p of Array.from(fragment.querySelectorAll('p'))) {
    if (!p.textContent?.trim() && !p.querySelector('img, hr, br')) {
      p.remove();
    }
  }
  for (const element of fragment.querySelectorAll('a, img')) {
    const attr = element.tagName === 'A' ? 'href' : 'src';
    const raw = element.getAttribute(attr);
    const url = raw ? safeUrl(raw, bundle.entry.link || undefined) : null;
    if (url) element.setAttribute(attr, url);
    else element.removeAttribute(attr);
    if (element.tagName === 'A') {
      element.setAttribute('target', '_blank'); element.setAttribute('rel', 'noopener noreferrer');
    } else {
      element.setAttribute('loading', 'lazy'); element.setAttribute('referrerpolicy', 'no-referrer');
    }
  }
  return fragment;
}
function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
