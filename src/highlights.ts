import { setIcon, setTooltip } from 'obsidian';
import type { Highlight, HighlightStyle } from './model';

export function createHighlightId(): string {
  return `hl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Wraps all text nodes intersected by a Range inside `<mark class="qrs-hl ...">` elements.
 * Handles cross-paragraph and cross-element ranges cleanly by splitting boundary text nodes.
 */
export function wrapRangeWithHighlight(doc: Document, range: Range, highlight: Highlight): HTMLElement[] {
  if (range.collapsed) return [];

  const root = range.commonAncestorContainer;
  const marks: HTMLElement[] = [];

  const walker = doc.createTreeWalker(
    root.nodeType === Node.TEXT_NODE ? root.parentNode || root : root,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        if (!node.textContent || !node.textContent.trim().length) return NodeFilter.FILTER_REJECT;
        const nodeRange = doc.createRange();
        nodeRange.selectNodeContents(node);
        if (range.compareBoundaryPoints(Range.END_TO_START, nodeRange) >= 0) return NodeFilter.FILTER_REJECT;
        if (range.compareBoundaryPoints(Range.START_TO_END, nodeRange) <= 0) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    }
  );

  const textNodes: Text[] = [];
  if (root.nodeType === Node.TEXT_NODE) {
    textNodes.push(root as Text);
  } else {
    let current = walker.nextNode();
    while (current) {
      textNodes.push(current as Text);
      current = walker.nextNode();
    }
  }

  if (!textNodes.length) return [];

  for (const textNode of textNodes) {
    const isStartNode = textNode === range.startContainer;
    const isEndNode = textNode === range.endContainer;

    let targetNode = textNode;
    const startOffset = isStartNode ? range.startOffset : 0;
    const endOffset = isEndNode ? range.endOffset : textNode.textContent?.length ?? 0;

    if (isEndNode && endOffset < targetNode.length) {
      targetNode.splitText(endOffset);
    }
    if (isStartNode && startOffset > 0) {
      targetNode = targetNode.splitText(startOffset);
    }

    if (!targetNode.textContent?.trim().length) continue;

    const parent = targetNode.parentElement;
    if (parent && parent.classList.contains('qrs-hl')) {
      parent.dataset.hlId = highlight.id;
      parent.dataset.hlStyle = highlight.style;
      parent.className = `qrs-hl qrs-hl-${highlight.style}${highlight.note ? ' qrs-hl-has-note' : ''}`;
      marks.push(parent);
      continue;
    }

    const mark = doc.defaultView ? doc.defaultView.document.createElement('mark') : doc.createElement('mark');
    mark.className = `qrs-hl qrs-hl-${highlight.style}${highlight.note ? ' qrs-hl-has-note' : ''}`;
    mark.dataset.hlId = highlight.id;
    mark.dataset.hlStyle = highlight.style;
    if (targetNode.parentNode) {
      targetNode.parentNode.insertBefore(mark, targetNode);
      mark.appendChild(targetNode);
      marks.push(mark);
    }
  }

  return marks;
}

/**
 * Restores saved highlights into the rendered prose container.
 * Uses exact or normalized text matching across text nodes.
 */
export function restoreHighlightsInContainer(container: HTMLElement, highlights: Highlight[]): void {
  if (!highlights.length) return;
  const doc = container.ownerDocument;

  for (const hl of highlights) {
    const targetText = hl.text.trim();
    if (!targetText) continue;

    const existing = container.querySelector(`mark[data-hl-id="${hl.id}"]`);
    if (existing) continue;

    const walker = doc.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
    const textNodes: Text[] = [];
    let textNode = walker.nextNode();
    while (textNode) {
      if (textNode.textContent && textNode.textContent.length > 0) {
        textNodes.push(textNode as Text);
      }
      textNode = walker.nextNode();
    }

    let fullText = '';
    const nodeOffsets: Array<{ node: Text; start: number; end: number }> = [];
    for (const tn of textNodes) {
      const len = tn.textContent?.length || 0;
      nodeOffsets.push({ node: tn, start: fullText.length, end: fullText.length + len });
      fullText += tn.textContent || '';
    }

    let matchIdx = fullText.indexOf(targetText);
    if (matchIdx === -1) {
      const simplifiedTarget = targetText.replace(/\s+/g, ' ');
      const simplifiedFull = fullText.replace(/\s+/g, ' ');
      const simIdx = simplifiedFull.indexOf(simplifiedTarget);
      if (simIdx !== -1) {
        matchIdx = simIdx;
      }
    }

    if (matchIdx === -1) continue;

    const matchEnd = matchIdx + targetText.length;
    const range = doc.createRange();
    let startSet = false;
    for (const item of nodeOffsets) {
      if (!startSet && item.end > matchIdx) {
        const offset = Math.max(0, matchIdx - item.start);
        range.setStart(item.node, Math.min(offset, item.node.length));
        startSet = true;
      }
      if (item.end >= matchEnd) {
        const offset = Math.max(0, matchEnd - item.start);
        range.setEnd(item.node, Math.min(offset, item.node.length));
        break;
      }
    }

    if (startSet) {
      wrapRangeWithHighlight(doc, range, hl);
    }
  }
}

/**
 * Removes all highlight mark elements belonging to a specific highlightId.
 */
export function removeHighlightFromContainer(container: HTMLElement, highlightId: string): void {
  const marks = container.querySelectorAll(`mark[data-hl-id="${highlightId}"]`);
  marks.forEach(mark => {
    const parent = mark.parentNode;
    while (mark.firstChild) {
      parent?.insertBefore(mark.firstChild, mark);
    }
    mark.remove();
    parent?.normalize();
  });
}

/**
 * Updates all highlight mark elements belonging to a specific highlightId.
 */
export function updateHighlightInContainer(container: HTMLElement, highlight: Highlight): void {
  const marks = container.querySelectorAll(`mark[data-hl-id="${highlight.id}"]`);
  marks.forEach(el => {
    const mark = el as HTMLElement;
    mark.dataset.hlStyle = highlight.style;
    mark.className = `qrs-hl qrs-hl-${highlight.style}${highlight.note ? ' qrs-hl-has-note' : ''}`;
  });
}

export interface HighlightCardOptions {
  anchor: HTMLElement;
  highlight: Highlight;
  doc: Document;
  onUpdate: (updated: Highlight) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onClose?: () => void;
}

/**
 * Floating popover card shown when clicking an existing highlight in the article.
 */
export class HighlightCard {
  private el?: HTMLElement;
  private outsideHandler?: (event: MouseEvent) => void;

  constructor(private options: HighlightCardOptions) {
    this.render();
  }

  private render() {
    this.close();
    const { anchor, highlight, doc } = this.options;
    const rect = anchor.getBoundingClientRect();
    const viewport = doc.documentElement;

    const card = doc.body.createDiv({ cls: 'qrs-hl-card' });
    this.el = card;

    const header = card.createDiv({ cls: 'qrs-hl-card-header' });
    const styles: Array<{ id: HighlightStyle; label: string; icon: string }> = [
      { id: 'highlight', label: '高亮', icon: 'highlighter' },
      { id: 'underline', label: '划线', icon: 'underline' },
      { id: 'bold', label: '加粗', icon: 'bold' },
    ];

    const styleGroup = header.createDiv({ cls: 'qrs-hl-style-group' });
    for (const s of styles) {
      const btn = styleGroup.createEl('button', {
        cls: `qrs-hl-style-btn${highlight.style === s.id ? ' is-active' : ''}`,
        attr: { 'aria-label': s.label },
      });
      setIcon(btn, s.icon);
      setTooltip(btn, s.label);
      btn.onclick = async (e) => {
        e.stopPropagation();
        highlight.style = s.id;
        styleGroup.querySelectorAll('.qrs-hl-style-btn').forEach(b => b.removeClass('is-active'));
        btn.addClass('is-active');
        await this.options.onUpdate(highlight);
      };
    }

    const actions = header.createDiv({ cls: 'qrs-hl-card-actions' });

    const copyBtn = actions.createEl('button', { cls: 'qrs-icon-btn', attr: { 'aria-label': '复制文本' } });
    setIcon(copyBtn, 'copy');
    setTooltip(copyBtn, '复制文本');
    copyBtn.onclick = async (e) => {
      e.stopPropagation();
      await navigator.clipboard.writeText(highlight.text);
      setTooltip(copyBtn, '已复制');
    };

    const delBtn = actions.createEl('button', { cls: 'qrs-icon-btn is-danger', attr: { 'aria-label': '删除划线' } });
    setIcon(delBtn, 'trash-2');
    setTooltip(delBtn, '删除划线与笔记');
    delBtn.onclick = async (e) => {
      e.stopPropagation();
      this.close();
      await this.options.onDelete(highlight.id);
    };

    const noteArea = card.createEl('textarea', {
      cls: 'qrs-hl-note-input',
      attr: { placeholder: '写下想法 / 批注…', rows: '3' },
    });
    noteArea.value = highlight.note || '';

    const saveNote = async () => {
      const val = noteArea.value.trim();
      if (val !== highlight.note) {
        highlight.note = val;
        await this.options.onUpdate(highlight);
      }
    };

    noteArea.onblur = () => void saveNote();
    noteArea.onkeydown = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        void saveNote();
        this.close();
      }
    };

    const cardWidth = 280;
    const left = Math.max(12, Math.min(rect.left + rect.width / 2 - cardWidth / 2, viewport.clientWidth - cardWidth - 12));
    const top = rect.bottom + 8 + 180 > viewport.clientHeight
      ? Math.max(12, rect.top - 180)
      : rect.bottom + 8;

    card.setCssProps({
      '--qrs-card-left': `${left}px`,
      '--qrs-card-top': `${top}px`,
    });

    this.outsideHandler = (event: MouseEvent) => {
      if (!card.contains(event.target as Node) && !anchor.contains(event.target as Node)) {
        void saveNote();
        this.close();
      }
    };
    (doc.defaultView ?? window).setTimeout(() => {
      if (this.outsideHandler) doc.addEventListener('pointerdown', this.outsideHandler);
    }, 10);
  }

  close() {
    if (this.outsideHandler && this.el?.ownerDocument) {
      this.el.ownerDocument.removeEventListener('pointerdown', this.outsideHandler);
      this.outsideHandler = undefined;
    }
    this.el?.remove();
    this.el = undefined;
    this.options.onClose?.();
  }
}
