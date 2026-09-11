import { setTooltip } from 'obsidian';

export interface TocHeadingItem {
  id: string;
  element: HTMLElement;
  text: string;
  level: number; // 1 to 6
}

export class TocNavigator {
  private navEl: HTMLElement | null = null;
  private trackEl: HTMLElement | null = null;
  private headings: TocHeadingItem[] = [];
  private itemEls: HTMLButtonElement[] = [];
  private activeIndex: number = -1;
  private scrollHandler: (() => void) | null = null;
  private resizeHandler: (() => void) | null = null;
  private isDestroyed = false;
  private ticking = false;

  constructor(
    private readerEl: HTMLElement,
    private articleEl: HTMLElement,
  ) {}

  public mount(): boolean {
    this.extractHeadings();
    if (this.headings.length < 2) {
      // Don't render for articles with fewer than 2 headings
      return false;
    }

    this.render();
    this.bindEvents();
    this.updateActiveHeading();
    return true;
  }

  public destroy() {
    this.isDestroyed = true;
    if (this.scrollHandler) {
      this.readerEl.removeEventListener('scroll', this.scrollHandler);
      this.scrollHandler = null;
    }
    if (this.resizeHandler) {
      window.removeEventListener('resize', this.resizeHandler);
      this.resizeHandler = null;
    }
    if (this.navEl && this.navEl.parentElement) {
      this.navEl.remove();
    }
    this.navEl = null;
    this.trackEl = null;
    this.headings = [];
    this.itemEls = [];
  }

  private extractHeadings() {
    this.headings = [];
    // 1. Search for standard h1 - h6 inside article prose
    const headingEls = Array.from(
      this.articleEl.querySelectorAll<HTMLElement>('.qrs-prose h1, .qrs-prose h2, .qrs-prose h3, .qrs-prose h4, .qrs-prose h5, .qrs-prose h6')
    );

    const validStandard = headingEls
      .map((el, index) => {
        const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
        const tagMatch = el.tagName.match(/^H([1-6])$/i);
        const level = tagMatch ? parseInt(tagMatch[1], 10) : 2;
        if (!el.id) {
          el.id = `qrs-heading-${index}`;
        }
        return { id: el.id, element: el, text, level };
      })
      .filter(item => item.text.length >= 2 && item.text.length <= 90);

    if (validStandard.length >= 2) {
      this.headings = validStandard;
      return;
    }

    // 2. Comprehensive fallback for WeChat articles without <h1-h6> tags
    const blocks = Array.from(
      this.articleEl.querySelectorAll<HTMLElement>('.qrs-prose p, .qrs-prose section')
    );

    const noiseWords = ['微信扫一扫', '赞赏', '喜欢作者', '转载开白', '阅读原文', '点个在看', '点击关注', '商务合作', '免责声明', '作者简介', '延伸阅读'];
    const sectionRegex = /^(?:[0-9一二三四五六七八九十百]+[、. ]|第[0-9一二三四五六七八九十]+[章节部分篇]|Part\s+[0-9IVX]+|[A-Z0-9]+[、.])/i;

    const candidates: TocHeadingItem[] = [];

    for (let i = 0; i < blocks.length; i++) {
      const el = blocks[i];
      if (el.closest('blockquote') || el.closest('.qrs-missing-content-card') || el.closest('.qrs-ai-summary-card')) {
        continue;
      }

      const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (text.length < 3 || text.length > 70) continue;
      if (noiseWords.some(w => text.includes(w))) continue;

      const boldEls = Array.from(el.querySelectorAll('b, strong, [style*="font-weight: bold"], [style*="font-weight: 700"], [style*="font-weight: 600"]'));
      const boldText = boldEls.map(b => b.textContent || '').join('').replace(/\s+/g, ' ').trim();
      const isBold = boldText.length >= text.length * 0.5;
      const isNumbered = sectionRegex.test(text);

      if (isBold || isNumbered) {
        if (!el.id) {
          el.id = `qrs-sec-heading-${i}`;
        }
        candidates.push({
          id: el.id,
          element: el,
          text,
          level: isNumbered ? 2 : 3,
        });
      }
    }

    const deduped: TocHeadingItem[] = [];
    for (const item of candidates) {
      if (deduped.length === 0 || deduped[deduped.length - 1].text !== item.text) {
        deduped.push(item);
      }
    }

    if (deduped.length >= 2) {
      this.headings = deduped.slice(0, 35);
    }
  }

  private render() {
    const doc = this.articleEl.ownerDocument;
    this.navEl = doc.createElement('nav');
    this.navEl.className = 'qrs-toc-nav';
    this.navEl.setAttribute('aria-label', '文章目录导航');

    this.trackEl = doc.createElement('div');
    this.trackEl.className = 'qrs-toc-track';
    this.navEl.appendChild(this.trackEl);

    this.itemEls = [];

    this.headings.forEach((item, index) => {
      const btn = doc.createElement('button');
      btn.className = 'qrs-toc-item';
      btn.type = 'button';
      btn.setAttribute('data-level', String(item.level));
      btn.setAttribute('data-index', String(index));
      setTooltip(btn, item.text, { placement: 'left' });

      const tick = doc.createElement('span');
      tick.className = `qrs-toc-tick qrs-toc-tick-h${item.level}`;
      btn.appendChild(tick);

      btn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.scrollToHeading(item.element);
      };

      this.trackEl!.appendChild(btn);
      this.itemEls.push(btn);
    });

    // Insert nav as a sticky element right before the article element
    if (this.articleEl.parentElement) {
      this.articleEl.parentElement.insertBefore(this.navEl, this.articleEl);
    }
  }

  private bindEvents() {
    this.scrollHandler = () => {
      if (this.isDestroyed || this.ticking) return;
      this.ticking = true;
      window.requestAnimationFrame(() => {
        this.updateActiveHeading();
        this.ticking = false;
      });
    };

    this.readerEl.addEventListener('scroll', this.scrollHandler, { passive: true });

    this.resizeHandler = () => {
      if (this.isDestroyed) return;
      this.updateActiveHeading();
    };
    window.addEventListener('resize', this.resizeHandler, { passive: true });
  }

  private updateActiveHeading() {
    if (this.isDestroyed || this.headings.length === 0) return;

    let activeIdx = 0;
    const currentScroll = this.readerEl.scrollTop;

    if (currentScroll > 30) {
      const readerRect = this.readerEl.getBoundingClientRect();
      const triggerY = readerRect.top + 140;

      for (let i = 0; i < this.headings.length; i++) {
        const rect = this.headings[i].element.getBoundingClientRect();
        if (rect.top <= triggerY) {
          activeIdx = i;
        } else {
          break;
        }
      }
    }

    if (activeIdx !== this.activeIndex) {
      if (this.activeIndex >= 0 && this.itemEls[this.activeIndex]) {
        this.itemEls[this.activeIndex].classList.remove('is-active');
      }
      this.activeIndex = activeIdx;
      if (this.itemEls[activeIdx]) {
        this.itemEls[activeIdx].classList.add('is-active');
      }
    }
  }

  private scrollToHeading(targetEl: HTMLElement) {
    const readerRect = this.readerEl.getBoundingClientRect();
    const targetRect = targetEl.getBoundingClientRect();
    const currentScroll = this.readerEl.scrollTop;
    const targetScroll = currentScroll + (targetRect.top - readerRect.top) - 60;

    this.readerEl.scrollTo({
      top: Math.max(0, targetScroll),
      behavior: 'smooth',
    });
  }
}
