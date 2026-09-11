// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { TocNavigator } from '../src/toc-navigator';

describe('TocNavigator', () => {
  let readerEl: HTMLElement;
  let articleEl: HTMLElement;
  let proseEl: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = '';
    readerEl = document.createElement('div');
    readerEl.className = 'qrs-reader';
    document.body.appendChild(readerEl);

    articleEl = document.createElement('article');
    articleEl.className = 'qrs-article';
    readerEl.appendChild(articleEl);

    proseEl = document.createElement('div');
    proseEl.className = 'qrs-prose';
    articleEl.appendChild(proseEl);
  });

  it('does not mount if fewer than 2 headings exist', () => {
    proseEl.innerHTML = '<h2>只有唯一标题</h2><p>正文内容...</p>';
    const nav = new TocNavigator(readerEl, articleEl);
    const mounted = nav.mount();
    expect(mounted).toBe(false);
    expect(readerEl.querySelector('.qrs-toc-nav')).toBeNull();
    nav.destroy();
  });

  it('mounts and generates ticks and tooltips for standard h1-h6 headings', () => {
    proseEl.innerHTML = `
      <h2>一、引言与背景</h2>
      <p>内容段落 1</p>
      <h3>1.1 架构设计</h3>
      <p>内容段落 2</p>
      <h3>1.2 核心机制</h3>
      <p>内容段落 3</p>
      <h2>二、实践总结</h2>
      <p>内容段落 4</p>
    `;

    const nav = new TocNavigator(readerEl, articleEl);
    const mounted = nav.mount();
    expect(mounted).toBe(true);

    const navEl = readerEl.querySelector('.qrs-toc-nav');
    expect(navEl).not.toBeNull();

    const items = navEl?.querySelectorAll('.qrs-toc-item');
    expect(items).toHaveLength(4);

    // Check headings hierarchy classes
    expect(items?.[0].querySelector('.qrs-toc-tick')?.className).toContain('qrs-toc-tick-h2');
    expect(items?.[1].querySelector('.qrs-toc-tick')?.className).toContain('qrs-toc-tick-h3');
    expect(items?.[3].querySelector('.qrs-toc-tick')?.className).toContain('qrs-toc-tick-h2');

    // Check tooltip aria-label text
    expect(items?.[0].getAttribute('aria-label')).toBe('一、引言与背景');
    expect(items?.[1].getAttribute('aria-label')).toBe('1.1 架构设计');
    expect(items?.[3].getAttribute('aria-label')).toBe('二、实践总结');

    // First item should be active initially
    expect(items?.[0].classList.contains('is-active')).toBe(true);

    nav.destroy();
    expect(readerEl.querySelector('.qrs-toc-nav')).toBeNull();
  });

  it('supports WeChat styled bold section paragraphs as fallback', () => {
    proseEl.innerHTML = `
      <p><strong>1. 宏观周期与资本开支</strong></p>
      <p>正文内容描述...</p>
      <p><strong>2. 算力与电力瓶颈</strong></p>
      <p>正文内容描述 2...</p>
      <p><strong>3. 投资建议与策略</strong></p>
      <p>正文内容描述 3...</p>
    `;

    const nav = new TocNavigator(readerEl, articleEl);
    const mounted = nav.mount();
    expect(mounted).toBe(true);

    const items = readerEl.querySelectorAll('.qrs-toc-item');
    expect(items).toHaveLength(3);
    expect(items[0].getAttribute('aria-label')).toBe('1. 宏观周期与资本开支');
    expect(items[1].getAttribute('aria-label')).toBe('2. 算力与电力瓶颈');

    nav.destroy();
  });

  it('triggers smooth scroll when tick button is clicked', () => {
    proseEl.innerHTML = `
      <h2 id="sec-1">章节一</h2>
      <p>文本...</p>
      <h2 id="sec-2">章节二</h2>
      <p>文本...</p>
    `;

    readerEl.scrollTo = vi.fn();

    const nav = new TocNavigator(readerEl, articleEl);
    nav.mount();

    const items = readerEl.querySelectorAll<HTMLButtonElement>('.qrs-toc-item');
    items[1].click();

    expect(readerEl.scrollTo).toHaveBeenCalled();

    nav.destroy();
  });
});
