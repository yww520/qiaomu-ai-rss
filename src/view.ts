import { addSearchClear } from './search-clear';
import { ChannelPicker, channelMark, type ChannelChoice } from './channel-picker';
import { Component, MarkdownRenderer, ItemView, Menu, Modal, Notice, Platform, setIcon, type WorkspaceLeaf } from 'obsidian';
import type QiaomuRssPlugin from './main';
import { vaultSourceId } from './vault-source';
import { enableImageDrag, prepareMarkdownImageDrags } from './image-drag';
import { SelectionCapture } from './selection';
import { readingFonts, selectableFonts, fontFamily } from './fonts';
import { articleFragment } from './content';
import { canonicalEntryKey, modeLabels, modeSchema, readingFontSchema, safeUrl, titleOf, type ChannelState, type Bundle, type Entry, type Mode, type Highlight, type HighlightStyle } from './model';
import { createHighlightId, wrapRangeWithHighlight, restoreHighlightsInContainer, removeHighlightFromContainer, updateHighlightInContainer, HighlightCard } from './highlights';
import { WeMpClient } from './wemp-api';
import { generateArticleSummary } from './ai-summary';
export const VIEW_TYPE = 'qiaomu-ai-rss-reader';
type Filter = 'all' | 'unread' | 'favorites';
function feedHost(url: string) { try { return new URL(url).hostname; } catch { return 'RSS'; } }
function extractBundleText(bundle: Bundle, mode: Mode): string {
  if (bundle.entry.origin === 'vault' && bundle.entry.markdown) {
    return bundle.entry.markdown;
  }
  if (mode === 'rewrite' && bundle.rewrite?.body?.trim()) {
    return bundle.rewrite.body;
  }
  if (mode === 'translation' && bundle.translation?.content?.length) {
    return bundle.translation.content.map(p => p.target || p.targetHtml || '').join('\n\n');
  }
  if (bundle.rewrite?.body?.trim()) {
    return bundle.rewrite.body;
  }
  if (bundle.entry.content?.trim()) {
    return bundle.entry.content
      .replace(/<\/(?:p|section|article|div|h[1-6]|li)>/gi, '\n\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
  return bundle.entry.summary || '';
}
export class ReaderView extends ItemView {
  private channelPicker?: ChannelPicker;
  private restoreObserver?: ResizeObserver;
  private pendingScroll?: { listTop: number; readerTop: number };
  private checkpointTimer?: number;
  private lastListTop = 0;
  private lastReaderTop = 0;
  private activeSwipedWrap: HTMLElement | null = null;
  private summarizingEntryId: string | null = null;
  private summaryError: string | null = null;
  private summaryErrorEntryId: string | null = null;
  private summaryCollapsed = false;
  private channelKey() { return JSON.stringify([this.plugin.state.settings.baseUrl, this.source]); }
  private closeSwipedWrap(wrap: HTMLElement) {
    const row = wrap.querySelector('.qrs-entry') as HTMLElement;
    if (row) row.setCssProps({ '--qrs-swipe-transform': '' });
    wrap.removeClass('is-swiped-open');
    if (this.activeSwipedWrap === wrap) this.activeSwipedWrap = null;
  }
  private deduplicateEntries(entries: Entry[]): Entry[] {
    const deleted = new Set(this.plugin.state.deletedIds || []);
    const map = new Map<string, Entry>();
    for (const entry of entries) {
      if (deleted.has(entry.id)) continue;
      const key = canonicalEntryKey(entry);
      if (deleted.has(key)) continue;
      const existing = map.get(key);
      if (!existing) {
        map.set(key, entry);
      } else {
        map.set(key, this.pickBetterEntry(existing, entry));
      }
    }
    return Array.from(map.values()).sort((a, b) => (b.publishedTs || 0) - (a.publishedTs || 0));
  }
  private pickBetterEntry(a: Entry, b: Entry): Entry {
    const state = this.plugin.state;
    const aFav = !!state.favorites[a.id];
    const bFav = !!state.favorites[b.id];
    if (aFav && !bFav) return a;
    if (bFav && !aFav) return b;

    const aRead = state.readIds.includes(a.id);
    const bRead = state.readIds.includes(b.id);
    if (aRead && !bRead) return a;
    if (bRead && !aRead) return b;

    if (a.rewrite && !b.rewrite) return a;
    if (b.rewrite && !a.rewrite) return b;
    if (a.summaryZh && !b.summaryZh) return a;
    if (b.summaryZh && !a.summaryZh) return b;

    const aLen = a.content?.length || 0;
    const bLen = b.content?.length || 0;
    if (aLen !== bLen) return aLen > bLen ? a : b;
    return a;
  }
  async deleteArticle(entry: Entry) {
    const key = canonicalEntryKey(entry);
    const id = entry.id;

    const deletedSet = new Set(this.plugin.state.deletedIds || []);
    deletedSet.add(id);
    if (key) deletedSet.add(key);
    this.plugin.state.deletedIds = Array.from(deletedSet).slice(-2000);

    this.entries = this.entries.filter(e => e.id !== id && canonicalEntryKey(e) !== key);

    for (const sub of this.plugin.state.subscriptions) {
      sub.entries = sub.entries.filter(e => e.id !== id && canonicalEntryKey(e) !== key);
    }
    this.plugin.state.entries = this.plugin.state.entries.filter(e => e.id !== id && canonicalEntryKey(e) !== key);

    for (const st of Object.values(this.plugin.state.channelStates)) {
      st.entries = st.entries.filter(e => e.id !== id && canonicalEntryKey(e) !== key);
      if (st.bundle?.entry.id === id || (st.bundle && canonicalEntryKey(st.bundle.entry) === key)) {
        st.bundle = null;
      }
    }

    if (this.bundle?.entry.id === id || (this.bundle && canonicalEntryKey(this.bundle.entry) === key)) {
      this.bundle = null;
      this.contentEl.removeClass('qrs-has-article');
      this.renderReader();
    }

    delete this.plugin.state.cache[id];
    delete this.plugin.state.favorites[id];

    await this.plugin.persist();
    this.renderList();
    new Notice(`已删除文章: ${titleOf(entry)}`);
  }
  async deleteArticleWithAnimation(wrap: HTMLElement, entry: Entry) {
    if (wrap.hasClass('is-deleting')) return;
    wrap.addClass('is-deleting');
    const row = wrap.querySelector('.qrs-entry') as HTMLElement;
    if (row) row.setCssProps({ '--qrs-swipe-transform': 'translateX(100%)' });
    await new Promise(r => window.setTimeout(r, 220));
    await this.deleteArticle(entry);
  }
  private saveChannel() {
    if (!this.list || !this.reader) return;
    this.plugin.state.channelStates[this.channelKey()] = {
      entries: this.deduplicateEntries(this.entries), bundle: this.bundle, mode: this.mode, filter: this.filter, query: this.query,
      unread: [...this.unreadSession], cursor: this.cursor, hasMore: this.hasMore,
      listTop: this.pendingScroll?.listTop ?? (this.list.clientHeight ? this.list.scrollTop : this.lastListTop),
      readerTop: this.pendingScroll?.readerTop ?? (this.reader.clientHeight ? this.reader.scrollTop : this.lastReaderTop), articlePending: this.articleLoading,
    };
  }
  private stopRestoring() { this.pendingScroll = undefined; this.restoreObserver?.disconnect(); }
  private restoreOffsets() {
    this.restoreObserver?.disconnect();
    if (!this.pendingScroll) return;
    const apply = () => { if (this.pendingScroll) {
      this.list.scrollTop = this.pendingScroll.listTop; this.reader.scrollTop = this.pendingScroll.readerTop;
    } };
    apply(); this.restoreObserver = new ResizeObserver(apply);
    const article = this.reader.querySelector('.qrs-article'); if (article) this.restoreObserver.observe(article);
    this.restoreObserver.observe(this.list); this.restoreObserver.observe(this.reader);
  }
  private restoreChannel(saved: ChannelState) {
    this.entries = this.deduplicateEntries(saved.entries); this.bundle = saved.bundle; this.mode = saved.mode;
    this.filter = saved.filter; this.query = saved.query; this.unreadSession = new Set(saved.unread);
    this.cursor = saved.cursor; this.hasMore = saved.hasMore; this.lastListTop = saved.listTop; this.lastReaderTop = saved.readerTop;
    this.pendingScroll = { listTop: saved.listTop, readerTop: saved.readerTop };
    this.searchInput.value = this.query; this.searchBox.toggleClass('is-hidden', !this.query);
    this.contentEl.toggleClass('qrs-has-article', !!this.bundle);
    this.renderFilters(); this.renderList(); this.renderReader(); this.restoreOffsets();
    if (saved.articlePending && saved.bundle) void this.openArticle(saved.bundle.entry, saved);
  }
  private markdownComponent?: Component;
  private selectionCapture?: SelectionCapture;
  private list!: HTMLElement;
  private reader!: HTMLElement;
  private status!: HTMLElement;
  private channelButton!: HTMLButtonElement;
  private searchBox!: HTMLElement;
  private searchInput!: HTMLInputElement;
  private welcomeSource?: string;
  private welcomeTip = -1;
  private refreshButton!: HTMLButtonElement;
  private filters!: HTMLElement;
  private entries: Entry[] = [];
  private source = '';
  private filter: Filter = 'all';
  private unreadSession = new Set<string>();
  private query = '';
  private cursor = '';
  private hasMore = false;
  private loading = false;
  private articleLoading = false;
  private focused = false;
  private appearanceOpen = false;
  private appearanceId = `qrs-reading-settings-${crypto.randomUUID()}`;
  private listVersion = 0;
  private articleVersion = 0;
  private renderVersion = 0;
  private bundle: Bundle | null = null;
  private mode: Mode;
  private closed = false;
  private message = '';
  private blobUrls: string[] = [];
  private thumbnailUrls = new Map<string, string>();
  private thumbnailPending = new Map<string, Promise<string | null>>();
  private thumbnailVersion = 0;
  private imageObserver?: IntersectionObserver;
  private activeHighlightCard?: HighlightCard;

  getHighlights(): Highlight[] {
    if (!this.bundle) return [];
    return this.plugin.state.highlights[this.bundle.entry.id] || [];
  }

  async addHighlight(range: Range, text: string, style: HighlightStyle, note = ''): Promise<void> {
    if (!this.bundle) return;
    const entryId = this.bundle.entry.id;
    const id = createHighlightId();
    const hl: Highlight = {
      id,
      entryId,
      text,
      style,
      note,
      createdAt: Date.now(),
    };

    // 1. Wrap visually
    const marks = wrapRangeWithHighlight(this.contentEl.ownerDocument, range, hl);
    if (!marks.length) return;

    // 2. Persist
    const list = this.plugin.state.highlights[entryId] || [];
    this.plugin.state.highlights[entryId] = [...list, hl];
    await this.plugin.persist();

    // 3. Clear window selection
    this.contentEl.ownerDocument.getSelection()?.removeAllRanges();

    // 4. Update highlights count badge on toolbar if exists
    this.updateNotesBadge();

    // If note is empty and created via "写想法", pop up the card immediately
    if (note === '__OPEN_CARD__') {
      hl.note = '';
      this.openHighlightCard(marks[0], hl);
    }
  }

  async updateHighlight(updated: Highlight): Promise<void> {
    if (!this.bundle) return;
    const entryId = this.bundle.entry.id;
    const list = this.plugin.state.highlights[entryId] || [];
    this.plugin.state.highlights[entryId] = list.map(h => (h.id === updated.id ? updated : h));
    await this.plugin.persist();

    const prose = this.reader.querySelector('.qrs-prose') as HTMLElement;
    if (prose) updateHighlightInContainer(prose, updated);
  }

  async deleteHighlight(id: string): Promise<void> {
    if (!this.bundle) return;
    const entryId = this.bundle.entry.id;
    const list = this.plugin.state.highlights[entryId] || [];
    this.plugin.state.highlights[entryId] = list.filter(h => h.id !== id);
    await this.plugin.persist();

    const prose = this.reader.querySelector('.qrs-prose') as HTMLElement;
    if (prose) removeHighlightFromContainer(prose, id);
    this.updateNotesBadge();
  }

  openHighlightCard(anchor: HTMLElement, highlight: Highlight): void {
    this.activeHighlightCard?.close();
    this.activeHighlightCard = new HighlightCard({
      anchor,
      highlight,
      doc: this.contentEl.ownerDocument,
      onUpdate: async (up) => { await this.updateHighlight(up); },
      onDelete: async (id) => { await this.deleteHighlight(id); },
      onClose: () => { this.activeHighlightCard = undefined; },
    });
  }

  openImageModal(src: string, alt = ''): void {
    new ImageModal(this.app, src, alt).open();
  }

  private updateNotesBadge() {
    const badge = this.reader.querySelector('.qrs-notes-badge');
    const count = this.getHighlights().length;
    if (badge) {
      badge.setText(count > 0 ? String(count) : '');
      badge.parentElement?.toggleClass('has-notes', count > 0);
    }
  }
  constructor(leaf: WorkspaceLeaf, private plugin: QiaomuRssPlugin) {
    super(leaf); this.mode = plugin.state.settings.defaultMode;
  }
  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return 'Qiaomu AI RSS'; }
  getIcon() { return 'rss'; }
  onOpen(): Promise<void> {
    this.reset();
    this.registerDomEvent(this.contentEl.ownerDocument, 'pointerdown', event => {
      const target = event.target as HTMLElement;
      if (!this.appearanceOpen || target.closest?.('.qrs-reading-settings') || target.closest?.('[data-qrs-label="阅读设置"]')) return;
      this.appearanceOpen = false; this.reader.querySelector('.qrs-reading-settings')?.remove();
      this.reader.querySelector('[aria-controls="' + this.appearanceId + '"]')?.setAttribute('aria-expanded', 'false');
      this.run(() => this.plugin.persist());
    });
    this.registerDomEvent(this.contentEl, 'contextmenu', event => {
      // Let mobile WebViews open their native text-selection handles.
      if (Platform.isMobileApp || ('pointerType' in event && event.pointerType === 'touch')) return;
      const target = event.target;
      if (!(target instanceof this.contentEl.ownerDocument.defaultView!.HTMLElement) || !target.closest('.qrs-article') || !this.bundle) return;
      event.preventDefault();
      const bundle = this.bundle, mode = this.mode, note = this.plugin.currentNote();
      const selection = this.contentEl.ownerDocument.getSelection();
      const prose = target.closest('.qrs-article')?.querySelector('.qrs-prose');
      const excerpt = selection && prose?.contains(selection.anchorNode) && prose.contains(selection.focusNode) ? selection.toString().trim() : '';
      const append = async (current: boolean) => {
        try {
          this.plugin.remember(bundle);
          const result = await this.plugin.appendToDailyNote(bundle.entry, excerpt, mode, current && note ? note : undefined);
          new Notice(result.added ? `已追加到 ${result.file.basename}` : '这篇文章或摘录已在笔记中。');
        } catch (error) { new Notice(error instanceof Error ? error.message : '无法追加到笔记。'); }
      };
      new Menu().setUseNativeMenu(false)
        .addItem(item => item.setTitle(note ? `追加到当前笔记：${note.basename}` : '追加到当前笔记（请先打开笔记）').setIcon('file-pen-line').setDisabled(!note).onClick(() => append(true)))
        .addItem(item => item.setTitle('追加到今日日记').setIcon('calendar-days').onClick(() => append(false)))
        .showAtMouseEvent(event);
    });
    this.selectionCapture = new SelectionCapture(this.contentEl.ownerDocument, () => this.reader, () => {
      const bundle = this.bundle, mode = this.mode;
      if (!bundle || !this.plugin.state.settings.selectionPopup) return null;
      const note = this.plugin.currentNote();
      const capture = async (text: string, current: boolean) => {
        try {
          this.plugin.remember(bundle);
          const result = current && note
            ? await this.plugin.appendToDailyNote(bundle.entry, text, mode, note)
            : await this.plugin.noteArticle(bundle.entry, text, mode);
          new Notice(result.added ? `摘录已添加到 ${result.file.basename}` : '这段摘录已在笔记中。');
        } catch (error) { new Notice(error instanceof Error ? error.message : '摘录失败，请重试。'); }
      };
      return [
        {
          label: '高亮',
          icon: 'highlighter',
          className: 'qrs-btn-hl',
          save: ctx => this.addHighlight(ctx.range, ctx.text, 'highlight'),
        },
        {
          label: '划线',
          icon: 'underline',
          className: 'qrs-btn-underline',
          save: ctx => this.addHighlight(ctx.range, ctx.text, 'underline'),
        },
        {
          label: '重点加粗',
          icon: 'bold',
          className: 'qrs-btn-bold',
          save: ctx => this.addHighlight(ctx.range, ctx.text, 'bold'),
        },
        {
          label: '写想法 / 批注',
          icon: 'message-square-plus',
          className: 'qrs-btn-note',
          save: ctx => this.addHighlight(ctx.range, ctx.text, 'highlight', '__OPEN_CARD__'),
        },
        {
          label: '追加到今日日记',
          icon: 'calendar-plus',
          save: ctx => capture(ctx.text, false),
        },
        {
          label: note ? `追加到当前笔记：${note.basename}` : '追加到当前笔记（请先打开笔记）',
          icon: 'file-pen-line',
          disabled: !note,
          save: ctx => capture(ctx.text, true),
        },
      ];
    });
    return Promise.resolve();
  }
  onClose(): Promise<void> {
    this.saveChannel(); this.channelPicker?.close(false); this.stopRestoring();
    if (this.checkpointTimer) window.clearTimeout(this.checkpointTimer);
    this.selectionCapture?.dispose();
    this.closed = true; this.listVersion++; this.articleVersion++; this.clearImages(); this.clearThumbnails(); this.contentEl.onkeydown = null;
    return this.plugin.persist().catch(() => undefined);
  }
  reset() {
    this.channelPicker?.close(false); this.stopRestoring();
    if (this.checkpointTimer) window.clearTimeout(this.checkpointTimer);
    this.unreadSession.clear();
    this.closed = false; this.listVersion++; this.articleVersion++; this.clearThumbnails();
    const remembered = this.plugin.state.settings.lastSource;
    const localExists = this.plugin.state.subscriptions.some(feed => feed.id === remembered);
    const groupExists = remembered.startsWith('@group:') && this.plugin.state.subscriptions.some(feed => feed.group === remembered.slice(7));
    this.focused = false; this.source = remembered === '@local' || this.plugin.state.settings.markdownFolders.some(folder => vaultSourceId(folder) === remembered) || groupExists || localExists || this.plugin.state.sources.some(source => source.id === remembered) ? remembered : '';
    this.cursor = ''; this.bundle = null; this.loading = false; this.hasMore = false;
    this.mode = this.plugin.state.settings.defaultMode;
    this.entries = this.personalScope() ? this.localEntries() : this.source ? [] : this.plugin.state.entries;
    this.build();
    const saved = this.plugin.state.channelStates[this.channelKey()];
    if (saved) { this.restoreChannel(saved); if (!this.entries.length) void this.loadEntries(); }
    else { this.renderList(); this.renderReader(); void this.loadEntries(); }
  }
  private run(action: () => Promise<void>) {
    void action().catch(error => { if (!this.closed) new Notice(error instanceof Error ? error.message : '操作失败，请重试。'); });
  }
  private addIconButton(parent: HTMLElement, icon: string, label: string, action: () => void): HTMLButtonElement {
    const button = parent.createEl('button', { cls: 'qrs-icon', attr: { 'data-qrs-label': label } });
    setIcon(button, icon); button.createSpan({ cls: 'qrs-visually-hidden', text: label }); button.addEventListener('click', action); return button;
  }
  refreshPreferences() { this.selectionCapture?.clear(); this.applyAppearance(); if (this.appearanceOpen) this.renderReader(true); }
  private applyAppearance() {
    const settings = this.plugin.state.settings;
    this.contentEl.dataset.readingFont = settings.fontFamily;
    const font = readingFonts.find(font => font.id === settings.fontFamily)!;
    this.contentEl.setCssProps({ '--qrs-font-family': fontFamily(settings.fontFamily, settings.customFont) });
    void this.plugin.fonts.load(this.contentEl.ownerDocument, settings.fontFamily).catch(() => {
      if (!this.closed && this.plugin.state.settings.fontFamily === font.id) new Notice('字体加载失败，请重新选择重试。');
    });
    this.contentEl.setCssProps({
      '--qrs-font-size': `${settings.fontSize}px`, '--qrs-line-height': String(settings.lineHeight),
      '--qrs-article-width': `${settings.fontSize * settings.lineWidth + 120}px`,
    });
  }
  private build() {
    const root = this.contentEl; root.empty(); root.addClass('qrs-root'); root.removeClass('qrs-has-article');
    root.toggleClass('qrs-focus', this.focused); root.tabIndex = 0;
    root.setCssProps({ '--qrs-list-width': `${this.plugin.state.settings.listWidth}px` }); this.applyAppearance();
    const body = root.createDiv('qrs-layout');
    const sidebar = body.createEl('aside', { cls: 'qrs-sidebar' });
    const bar = sidebar.createDiv('qrs-sidebar-toolbar');
    this.channelButton = bar.createEl('button', { cls: 'qrs-channel', attr: { 'aria-haspopup': 'dialog' } });
    this.renderChannel(); this.channelButton.addEventListener('click', () => this.pickChannel());
    this.addIconButton(bar, 'plus', '添加或管理订阅', () => this.plugin.manageSubscriptions());
    this.addIconButton(bar, 'search', '搜索文章 /', () => this.toggleSearch());
    this.refreshButton = this.addIconButton(bar, 'refresh-cw', '刷新文章', () => { void this.loadEntries(false, true); });
    this.filters = sidebar.createDiv({ cls: 'qrs-filters', attr: { role: 'group' } });
    this.renderFilters();
    this.searchBox = sidebar.createDiv('qrs-search-box'); this.searchBox.toggleClass('is-hidden', !this.query);
    const searchId = `${this.appearanceId}-search`; this.searchBox.createEl('label', { cls: 'qrs-visually-hidden', text: '搜索已载入文章', attr: { for: searchId } });
    this.searchInput = this.searchBox.createEl('input', { type: 'search', placeholder: '搜索当前列表…', attr: { id: searchId } });
    addSearchClear(this.searchInput);
    this.searchInput.value = this.query;
    this.searchInput.addEventListener('input', () => { this.query = this.searchInput.value; this.unreadSession.clear(); this.renderList(); });
    this.searchInput.addEventListener('keydown', event => { if (event.key === 'Escape') { event.stopPropagation(); this.toggleSearch(false); } });
    this.status = sidebar.createDiv({ cls: 'qrs-status', attr: { role: 'status', 'aria-live': 'polite' } });
    this.list = sidebar.createDiv({ cls: 'qrs-list' });
    this.createResizeHandle(body);
    this.reader = body.createEl('section', { cls: 'qrs-reader', attr: { tabindex: '0' } });
    root.onkeydown = event => this.onReaderKey(event);
    for (const element of [this.list, this.reader]) {
      for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const) element.addEventListener(event, () => this.stopRestoring(), { passive: true });
      element.addEventListener('scroll', () => {
        if (this.activeSwipedWrap) this.closeSwipedWrap(this.activeSwipedWrap);
        if (this.list.clientHeight) this.lastListTop = this.list.scrollTop;
        if (this.reader.clientHeight) this.lastReaderTop = this.reader.scrollTop;
        if (this.checkpointTimer) window.clearTimeout(this.checkpointTimer);
        this.checkpointTimer = window.setTimeout(() => { this.saveChannel(); this.run(() => this.plugin.persist()); }, 700);
      });
    }
  }
  private renderChannel() {
    this.channelButton.empty();
    const choices = this.channelChoices();
    const choice = choices.find(item => item.id === this.source) || choices[0];
    channelMark(this.channelButton, choice); this.channelButton.createSpan({ cls: 'qrs-channel-label', text: choice.name });
    setIcon(this.channelButton.createSpan(), 'chevron-down');
  }
  private renderFilters() {
    this.filters.empty();
    for (const [value, label] of [['all', '全部'], ['unread', '未读'], ['favorites', '收藏']] as const) {
      const button = this.filters.createEl('button', { text: label, attr: { 'aria-pressed': String(value === this.filter), 'data-filter': value } });
      button.addEventListener('click', () => { this.filter = value; this.unreadSession.clear(); this.renderFilters(); this.renderList(); });
    }
    this.addIconButton(this.filters, 'settings', '插件设置', () => this.plugin.openSettings()).addClass('qrs-settings-button');
  }
  private channelChoices(): ChannelChoice[] {
    const feeds = this.plugin.state.subscriptions;
    const groups = [...new Set(feeds.map(feed => feed.group).filter(Boolean))].sort();
    return [
      { id: '', name: '乔木精选', section: '聚合', subtitle: '乔木筛选的高质量内容', icon: 'tree-deciduous' },
      { id: '@local', name: '我的订阅', section: '聚合', subtitle: `${feeds.length} 个个人订阅源`, icon: 'rss' },
      ...groups.map(group => ({ id: `@group:${group}`, name: group, section: '订阅分组' as const,
        subtitle: `${feeds.filter(feed => feed.group === group).length} 个订阅源`, icon: 'folder' })),
      ...feeds.map(feed => ({ id: feed.id, name: feed.name, section: '我的订阅源' as const,
        subtitle: `${feed.group ? `${feed.group} · ` : ''}${feedHost(feed.url)} · ${feed.entries.length} 篇`, monogram: feed.name.trim().slice(0, 1), group: feed.group })),
      ...this.plugin.state.sources.filter(source => source.enabled !== false).map(source => ({ id: source.id, name: source.name, section: '乔木频道' as const,
        subtitle: ({ article: '文章', news: '新闻', podcast: '播客' } as Record<string, string>)[source.category || ''] || source.category || '乔木内容频道', monogram: source.name.trim().slice(0, 1) })),
      ...this.plugin.state.settings.markdownFolders.map(folder => ({ id: vaultSourceId(folder), name: folder === '/' ? '整个库' : folder.split('/').at(-1)!, section: '库内文件夹' as const, subtitle: folder, icon: folder.endsWith('.md') ? 'file-text' : 'folder-open' })),
    ];
  }
  private vaultScope() { return this.source.startsWith('@vault:'); }
  private personalScope() { return this.source === '@local' || this.source.startsWith('@group:') || this.source.startsWith('local:'); }
  private selectedFeeds() {
    return this.plugin.state.subscriptions.filter(feed => this.source === '@local' || feed.id === this.source ||
      (this.source.startsWith('@group:') && feed.group === this.source.slice(7)));
  }
  private localEntries() { return this.deduplicateEntries(this.selectedFeeds().flatMap(feed => feed.entries)); }
  showSubscriptions() { this.selectSource('@local', false); }
  showSubscription(id: string) {
    if (this.plugin.state.subscriptions.some(feed => feed.id === id)) this.selectSource(id, false);
  }
  private pickChannel() {
    if (this.channelPicker) { this.channelPicker.close(); return; }
    this.channelPicker = new ChannelPicker(this.channelButton, this.channelChoices(), this.source, source => this.selectSource(source.id), () => { this.channelPicker = undefined; });
    this.channelPicker.load();
  }
  private selectSource(source: string, refresh = true) {
    if (source === this.source) { if (!refresh) void this.loadEntries(); return; }
    this.saveChannel(); this.stopRestoring();
    this.unreadSession.clear();
    this.listVersion++; this.loading = false; this.refreshButton.removeClass('is-loading');
    this.articleLoading = false; this.reader.setAttribute('aria-busy', 'false');
    this.source = source; this.cursor = ''; this.entries = []; this.hasMore = false;
    this.plugin.state.settings.lastSource = source; this.run(() => this.plugin.persist());
    this.bundle = null; this.articleVersion++; this.focused = false; this.contentEl.removeClass('qrs-focus');
    this.contentEl.removeClass('qrs-focus'); this.contentEl.removeClass('qrs-has-article');
    this.entries = this.personalScope() ? this.localEntries() : source ? [] : this.plugin.state.entries;
    this.status.setText(''); this.renderChannel();
    const saved = this.plugin.state.channelStates[this.channelKey()];
    if (saved) { this.restoreChannel(saved); if (!this.entries.length && refresh) void this.loadEntries(); return; }
    this.filter = 'all'; this.query = ''; this.searchInput.value = ''; this.searchBox.addClass('is-hidden'); this.lastListTop = 0; this.lastReaderTop = 0;
    this.renderFilters(); this.renderReader(); this.renderList(); this.list.scrollTop = 0; this.reader.scrollTop = 0;
    if (refresh) void this.loadEntries();
  }
  private toggleSearch(show = this.searchBox.hasClass('is-hidden')) {
    this.focused = false; this.contentEl.removeClass('qrs-focus'); this.contentEl.removeClass('qrs-has-article');
    this.searchBox.toggleClass('is-hidden', !show);
    if (show) this.searchInput.focus();
    else { this.query = ''; this.searchInput.value = ''; this.unreadSession.clear(); this.renderList(); this.contentEl.focus(); }
  }
  private createResizeHandle(parent: HTMLElement) {
    const labelId = `${this.appearanceId}-resize`; const handle = parent.createDiv({ cls: 'qrs-resize', attr: { role: 'separator', tabindex: '0', 'aria-labelledby': labelId, 'aria-orientation': 'vertical', 'aria-valuemin': '220', 'aria-valuemax': '520', 'aria-valuenow': String(this.plugin.state.settings.listWidth) } });
    handle.createSpan({ cls: 'qrs-visually-hidden', text: '调整文章列表宽度', attr: { id: labelId } });
    const resize = (width: number) => {
      const next = Math.round(Math.max(220, Math.min(520, width)));
      this.plugin.state.settings.listWidth = next;
      this.contentEl.setCssProps({ '--qrs-list-width': `${next}px` });
      handle.setAttribute('aria-valuenow', String(next));
    };
    handle.onpointerdown = event => {
      if (event.button !== 0) return;
      event.preventDefault(); handle.setPointerCapture(event.pointerId); handle.addClass('is-dragging');
      const x = event.clientX; const width = this.plugin.state.settings.listWidth;
      handle.onpointermove = move => resize(width + move.clientX - x);
    };
    const finish = () => { handle.onpointermove = null; handle.removeClass('is-dragging'); this.run(() => this.plugin.persist()); };
    handle.onpointerup = finish; handle.onlostpointercapture = finish; handle.onpointercancel = finish;
    handle.ondblclick = () => { resize(300); this.run(() => this.plugin.persist()); };
    handle.onkeydown = event => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault(); resize(this.plugin.state.settings.listWidth + (event.key === 'ArrowLeft' ? -20 : 20)); this.run(() => this.plugin.persist());
    };
  }
  private toggleFocus() {
    if (!this.bundle) return;
    if (this.contentEl.clientWidth <= 650) { this.contentEl.removeClass('qrs-has-article'); return; }
    this.focused = !this.focused; this.contentEl.toggleClass('qrs-focus', this.focused); this.renderReader(true);
  }
  private onReaderKey(event: KeyboardEvent) {
    const target = event.target as HTMLElement | null;
    if (event.key === 'Escape' && this.appearanceOpen) {
      event.preventDefault(); event.stopPropagation(); this.appearanceOpen = false; this.renderReader(true); return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing ||
      (target?.closest?.('input,textarea,select,[contenteditable=true]'))) return;
    const key = event.key.toLowerCase();
    if (key === 'j' || key === 'k') { event.preventDefault(); event.stopPropagation(); this.navigate(key === 'j' ? 1 : -1); }
    if (event.key === '[' || event.key === 'f') { event.preventDefault(); this.toggleFocus(); }
    if (event.key === '/') { event.preventDefault(); this.toggleSearch(true); }
    if (event.key === 'Escape') { this.focused = false; this.contentEl.removeClass('qrs-focus'); this.contentEl.removeClass('qrs-has-article'); }
  }
  private navigate(direction: number) {
    const entries = this.visibleEntries(); const index = entries.findIndex(entry => entry.id === this.bundle?.entry.id);
    const next = entries[index + direction]; if (next) void this.openArticle(next);
  }
  private async loadEntries(more = false, force = false) {
    if (this.loading && more) return;
    const version = ++this.listVersion; this.loading = true; this.status.setText(''); this.refreshButton.addClass('is-loading');
    const state = this.plugin.state;
    try {
      if (this.vaultScope()) { this.entries = this.plugin.vaultSources.entries(this.source.slice(7)); this.hasMore = false; return; }
      if (this.personalScope()) {
        const feeds = this.selectedFeeds();
        if (force) {
          const settings = this.plugin.state.settings;
          const client = new WeMpClient(() => settings.weMpServerUrl, () => settings.weMpToken);
          for (const feed of feeds) {
            const match = feed.url.match(/\/feed\/(?:MP_WXS_)?([0-9A-Za-z_-]+)\.xml/);
            if (match) {
              const mpId = match[1].startsWith('MP_WXS_') ? match[1] : `MP_WXS_${match[1]}`;
              void client.updateMpArticles(mpId, feed.name);
            }
          }
        }
        await this.plugin.subscriptions.refresh(feeds.map(feed => feed.id), this.reader.ownerDocument, force, () => {
          if (!this.closed && version === this.listVersion) { this.entries = this.localEntries(); this.renderList(); }
        });
        if (this.closed || version !== this.listVersion) return;
        this.entries = this.localEntries(); this.hasMore = false;
        const failed = feeds.filter(feed => feed.error).length;
        this.status.setText(failed ? `${failed} 个订阅刷新失败，保留已有文章。可在订阅管理中查看详情。` : '');
        return;
      }
      const api = this.plugin.api();
      const [page, sources] = await Promise.allSettled([api.entries(this.source, more ? this.cursor : ''), api.sources()]);
      if (this.closed || version !== this.listVersion) return;
      if (sources.status === 'fulfilled') { state.sources = sources.value.sources; this.renderChannel(); }
      if (page.status === 'rejected') throw page.reason;
      this.entries = more ? [...new Map([...this.entries, ...page.value.entries].map(entry => [entry.id, entry])).values()] : page.value.entries;
      this.cursor = page.value.nextCursor || ''; this.hasMore = !!page.value.hasMore && !!this.cursor;
      if (!this.source) { state.entries = this.entries; state.updatedAt = Date.now(); }
      await this.plugin.persist();
      if (this.closed || version !== this.listVersion) return;
      this.status.setText(sources.status === 'rejected' ? '频道加载失败，请刷新重试。' : '');
    } catch (error) {
      if (this.closed || version !== this.listVersion) return;
      this.status.setText(`${error instanceof Error ? error.message : '网络不可用。'}${this.entries.length ? ' 正在显示缓存。' : ' 点击刷新重试。'}`);
    } finally {
      if (!this.closed && version === this.listVersion) { this.loading = false; this.refreshButton.removeClass('is-loading'); this.renderList(); }
    }
  }
  private visibleEntries(): Entry[] {
    const state = this.plugin.state;
    const raw = this.filter === 'favorites' ? Object.values(state.favorites).map(b => b.entry) : this.entries;
    const entries = this.deduplicateEntries(raw);
    const query = this.query.trim().toLocaleLowerCase();
    return entries.filter(entry => (this.vaultScope() ? entry.origin === 'vault' && entry.sourceId === this.source : this.personalScope()
      ? entry.origin === 'local' && (this.source === '@local' || this.selectedFeeds().some(feed => feed.id === entry.sourceId))
      : entry.origin !== 'local' && entry.origin !== 'vault' && (!this.source || entry.sourceId === this.source)) &&
      (this.filter !== 'unread' || !state.readIds.includes(entry.id) || this.unreadSession.has(entry.id) || entry.id === this.bundle?.entry.id) &&
      (!query || `${titleOf(entry)} ${entry.title} ${entry.summary || ''} ${this.sourceName(entry)}`.toLocaleLowerCase().includes(query)));
  }
  private sourceName(entry: Entry) {
    const feed = this.plugin.state.subscriptions.find(f => f.id === entry.sourceId);
    if (feed && (feed.url.includes('FEATURED_ARTICLES') || feed.url.includes('/all.xml'))) {
      return entry.author || feed.name;
    }
    return feed?.name || entry.author || entry.sourceName || this.plugin.state.sources.find(source => source.id === entry.sourceId)?.name || entry.sourceId;
  }
  private excerpt(entry: Entry): string {
    if (entry.summaryZh) return entry.summaryZh.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`#]/g, '').slice(0, 160);
    if (entry.aiSummary) return entry.aiSummary.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`#]/g, '').slice(0, 160);
    const text = entry.rewrite?.body.split('\n\n').find(line => /[\u3400-\u9fff]/.test(line) && !line.startsWith('#') && !line.startsWith('!['));
    return (text || entry.summary || '').replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`#]/g, '').slice(0, 160);
  }
  private clearThumbnails() {
    this.thumbnailVersion++;
    for (const url of this.thumbnailUrls.values()) URL.revokeObjectURL(url);
    this.thumbnailUrls.clear(); this.thumbnailPending.clear();
  }
  private thumbnailUrl(url: string): Promise<string | null> {
    const cached = this.thumbnailUrls.get(url); if (cached) return Promise.resolve(cached);
    const pending = this.thumbnailPending.get(url); if (pending) return pending;
    const version = this.thumbnailVersion;
    const promise = this.plugin.images.load(url).then(blob => {
      if (this.closed || version !== this.thumbnailVersion) return null;
      const local = URL.createObjectURL(blob); this.thumbnailUrls.set(url, local); return local;
    }).catch(() => null);
    this.thumbnailPending.set(url, promise);
    void promise.finally(() => { if (this.thumbnailPending.get(url) === promise) this.thumbnailPending.delete(url); });
    return promise;
  }
  private renderThumbnail(row: HTMLElement, entry: Entry) {
    if (!this.plugin.state.settings.remoteImages) return;
    const url = entry.image ? safeUrl(entry.image, entry.link || undefined) : null; if (!url) return;
    const holder = row.createSpan('qrs-entry-thumb is-loading');
    const img = holder.createEl('img', { attr: { alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' } });
    void this.thumbnailUrl(url).then(local => {
      if (!local || !holder.isConnected) { holder.remove(); return; }
      img.onload = () => holder.removeClass('is-loading'); img.onerror = () => holder.remove(); img.src = local;
    });
  }
  private renderList() {
    this.activeSwipedWrap = null;
    const restoreFocus = this.list.contains(this.contentEl.ownerDocument.activeElement);
    const scroll = this.list.scrollTop; this.list.empty(); const entries = this.visibleEntries();
    if (!entries.length) this.list.createDiv({ cls: 'qrs-empty', text: this.loading ? '正在获取文章…' : this.filter === 'favorites' ? '收藏喜欢的文章，在这里慢慢读。' : this.personalScope() && !this.entries.length ? '还没有文章。点击 + 添加订阅，或点击刷新获取文章。' : '暂无匹配文章，试试其他频道或筛选。' });
    for (const entry of entries) {
      const read = this.plugin.state.readIds.includes(entry.id);
      const wrap = this.list.createDiv({ cls: 'qrs-entry-wrap' });

      const swipeAction = wrap.createDiv({ cls: 'qrs-entry-swipe-action' });
      const deleteBtn = swipeAction.createDiv({ cls: 'qrs-entry-delete-btn', attr: { role: 'button', 'aria-label': '删除文章' } });
      setIcon(deleteBtn.createSpan('qrs-entry-delete-icon'), 'trash');
      deleteBtn.createSpan({ text: '删除', cls: 'qrs-entry-delete-text' });

      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        void this.deleteArticleWithAnimation(wrap, entry);
      });

      const row = wrap.createEl('button', { cls: 'qrs-entry', attr: { 'data-entry-id': entry.id } });
      row.toggleClass('qrs-selected', this.bundle?.entry.id === entry.id);
      row.setAttribute('aria-pressed', String(this.bundle?.entry.id === entry.id)); row.toggleClass('qrs-read', read);
      const copy = row.createSpan('qrs-entry-copy');
      const meta = copy.createSpan('qrs-entry-meta');
      meta.createSpan({ text: this.sourceName(entry), cls: 'qrs-source-name' });
      const date = entry.publishedTs ? new Date(entry.publishedTs) : entry.published ? new Date(entry.published) : null;
      meta.createSpan({ cls: 'qrs-date', text: date && !Number.isNaN(date.getTime()) ? date.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' }) : '' });
      const title = copy.createDiv('qrs-entry-title');
      title.createSpan({ cls: read ? 'qrs-read-dot' : 'qrs-unread-dot', attr: { 'aria-hidden': 'true' } });
      title.createSpan({ cls: 'qrs-visually-hidden', text: read ? '已读' : '未读' });
      title.createEl('h3', { text: titleOf(entry) });
      if (this.plugin.state.favorites[entry.id]) setIcon(title.createSpan('qrs-bookmarked'), 'bookmark');
      const summary = this.excerpt(entry); if (summary) copy.createEl('p', { text: summary, cls: 'qrs-summary' });
      this.renderThumbnail(row, entry);

      let startX = 0;
      let startY = 0;
      let isTracking = false;
      let isSwiping = false;
      let isScrolling = false;
      let pointerId = -1;
      let suppressClick = false;

      row.addEventListener('pointerdown', (e: PointerEvent) => {
        if (e.button !== 0) return;
        if (this.activeSwipedWrap && this.activeSwipedWrap !== wrap) {
          this.closeSwipedWrap(this.activeSwipedWrap);
        }
        startX = e.clientX;
        startY = e.clientY;
        isTracking = true;
        isSwiping = false;
        isScrolling = false;
        pointerId = e.pointerId;
      });

      row.addEventListener('pointermove', (e: PointerEvent) => {
        if (!isTracking || e.pointerId !== pointerId) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;

        if (!isSwiping && !isScrolling) {
          if (Math.abs(dy) > 7 && Math.abs(dy) > Math.abs(dx)) {
            isScrolling = true;
            return;
          }
          if (dx > 7 && Math.abs(dx) > Math.abs(dy)) {
            isSwiping = true;
            try { row.setPointerCapture(pointerId); } catch { /* ignore */ }
            row.addClass('is-dragging');
          }
        }

        if (isSwiping) {
          const moveX = dx <= 0 ? 0 : dx < 80 ? dx : 80 + (dx - 80) * 0.45;
          row.setCssProps({ '--qrs-swipe-transform': `translateX(${Math.round(moveX)}px)` });
        }
      });

      const onPointerEnd = (e: PointerEvent) => {
        if (!isTracking || e.pointerId !== pointerId) return;
        isTracking = false;
        row.removeClass('is-dragging');
        try { row.releasePointerCapture(pointerId); } catch { /* ignore */ }

        if (isSwiping) {
          const dx = e.clientX - startX;
          suppressClick = true;
          window.setTimeout(() => { suppressClick = false; }, 150);

          if (dx >= 130) {
            void this.deleteArticleWithAnimation(wrap, entry);
          } else if (dx >= 45) {
            row.setCssProps({ '--qrs-swipe-transform': 'translateX(80px)' });
            wrap.addClass('is-swiped-open');
            this.activeSwipedWrap = wrap;
          } else {
            this.closeSwipedWrap(wrap);
          }
        }
      };

      row.addEventListener('pointerup', onPointerEnd);
      row.addEventListener('pointercancel', onPointerEnd);

      row.addEventListener('click', (e) => {
        if (suppressClick) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        if (wrap.hasClass('is-swiped-open')) {
          e.preventDefault();
          e.stopPropagation();
          this.closeSwipedWrap(wrap);
          return;
        }
        void this.openArticle(entry);
      });

      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const menu = new Menu();
        menu.addItem(item => {
          item.setTitle('删除文章')
            .setIcon('trash')
            .setWarning(true)
            .onClick(() => {
              void this.deleteArticleWithAnimation(wrap, entry);
            });
        });
        menu.showAtMouseEvent(e);
      });
    }
    if (this.hasMore && this.filter !== 'favorites') {
      const button = this.list.createEl('button', { text: this.loading ? '加载中…' : '加载更早文章', cls: 'qrs-more' });
      button.disabled = this.loading; button.addEventListener('click', () => { void this.loadEntries(true); });
    }
    this.list.scrollTop = scroll;
    if (restoreFocus) this.reader.focus({ preventScroll: true });
  }
  private async openArticle(entry: Entry, resume?: ChannelState) {
    this.stopRestoring();
    // Keep this unread reading session navigable after opening marks entries read.
    if (this.filter === 'unread') this.unreadSession.add(entry.id);
    const version = ++this.articleVersion; const state = this.plugin.state;
    this.bundle = state.cache[entry.id] || state.favorites[entry.id] || { entry, rewrite: entry.rewrite ?? null, translation: null, fetchedAt: 0 };
    state.readIds = [...new Set([...state.readIds, entry.id])].slice(-5000); this.run(() => this.plugin.persist());
    this.mode = entry.origin === 'local' || entry.origin === 'vault' ? 'original' : state.settings.defaultMode; this.message = ''; this.articleLoading = true; this.reader.setAttribute('aria-busy', 'true');
    this.contentEl.addClass('qrs-has-article'); this.renderReader(); this.reader.scrollTop = 0; this.lastReaderTop = 0; this.reader.focus({ preventScroll: true }); this.renderList();
    if (resume) { this.mode = resume.mode; this.pendingScroll = { listTop: resume.listTop, readerTop: resume.readerTop }; this.renderReader(); this.restoreOffsets(); }
    if (entry.origin === 'local') {
      this.bundle = { entry, rewrite: null, translation: null, fetchedAt: Date.now() };
      this.plugin.remember(this.bundle); this.run(() => this.plugin.persist());
      this.articleLoading = false; this.reader.setAttribute('aria-busy', 'false'); this.renderReader(); return;
    }
    try {
      const { bundle, warnings } = entry.origin === 'vault' ? { bundle: await this.plugin.vaultSources.article(entry), warnings: [] } : await this.plugin.api().article(entry.id);
      if (this.closed || version !== this.articleVersion) return;
      this.bundle = bundle; this.message = warnings.join('；'); this.plugin.remember(bundle); this.run(() => this.plugin.persist());
    } catch (error) {
      if (this.closed || version !== this.articleVersion) return;
      const cached = this.bundle.fetchedAt ? ` 正在显示 ${new Date(this.bundle.fetchedAt).toLocaleString()} 的缓存。` : ' 可重新打开文章重试。';
      this.message = `${error instanceof Error ? error.message : '获取正文失败。'}${cached}`;
    }
    if (!this.closed && version === this.articleVersion) { this.articleLoading = false; this.reader.setAttribute('aria-busy', 'false'); this.renderReader(); this.renderList(); }
  }
  showSavedArticle(bundle: Bundle, mode: Mode) {
    this.stopRestoring();
    this.articleVersion++; this.articleLoading = false;
    this.bundle = bundle; this.mode = mode; this.message = '';
    this.reader.setAttribute('aria-busy', 'false'); this.contentEl.addClass('qrs-has-article');
    this.renderReader(); this.reader.scrollTop = 0; this.lastReaderTop = 0; this.reader.focus({ preventScroll: true }); this.renderList();
  }
  private noteCurrent() {
    const bundle = this.bundle; if (!bundle) return;
    this.run(async () => {
      this.plugin.remember(bundle);
      const result = await this.plugin.noteArticle(bundle.entry, '', this.mode);
      new Notice(result.added ? `已保存至文章笔记：${result.file.basename}` : `笔记中已有该内容：${result.file.basename}`);
    });
  }
  private clearImages() {
    this.markdownComponent?.unload(); this.markdownComponent = undefined;
    this.renderVersion++; this.imageObserver?.disconnect(); this.imageObserver = undefined;
    for (const url of this.blobUrls) URL.revokeObjectURL(url);
    this.blobUrls = [];
  }
  private prepareImages(fragment: DocumentFragment) {
    const version = this.renderVersion;
    const load = async (img: HTMLImageElement, url: string, holder: HTMLElement) => {
      holder.querySelector('button')?.remove();
      try {
        const blob = await this.plugin.images.load(url);
        if (this.closed || version !== this.renderVersion) return;
        enableImageDrag(img, blob);
        const local = URL.createObjectURL(blob); this.blobUrls.push(local); img.src = local;
        img.onload = () => holder.removeClass('is-loading');
      } catch {
        if (this.closed || version !== this.renderVersion) return;
        holder.removeClass('is-loading');
        const button = holder.createEl('button', { text: '图片加载失败 · 重试', cls: 'qrs-image-retry' });
        button.onclick = () => { void load(img, url, holder); };
      }
    };
    this.imageObserver = new IntersectionObserver(items => {
      for (const item of items) {
        if (!item.isIntersecting) continue;
        const img = item.target as HTMLImageElement; this.imageObserver?.unobserve(img);
        const url = img.dataset.qrsImage;
        if (url && img.parentElement) void load(img, url, img.parentElement);
      }
    }, { root: this.reader, rootMargin: '500px' });
    for (const img of fragment.querySelectorAll('img')) {
      const url = img.getAttribute('src'); img.removeAttribute('src'); if (!url) { img.remove(); continue; }
      img.dataset.qrsImage = url;
      const holder = createSpan({ cls: 'qrs-image is-loading' });
      img.replaceWith(holder); holder.append(img); this.imageObserver.observe(img);
    }
  }
  private renderReader(keepContent = false) {
    this.selectionCapture?.clear();
    const active = this.contentEl.ownerDocument.activeElement;
    const restoreFocus = active !== this.reader && this.reader.contains(active);
    const scroll = this.reader.scrollTop;
    const previous = keepContent ? this.reader.querySelector('.qrs-article') : null;
    if (!previous) this.clearImages();
    this.reader.empty();
    // A removed toolbar button must not leave keyboard focus on document.body.
    if (restoreFocus) this.reader.focus({ preventScroll: true });
    const bundle = this.bundle;
    if (!bundle) {
      const empty = this.reader.createDiv('qrs-welcome');
      empty.createDiv({ cls: 'qrs-welcome-brand', text: 'QIAOMU RSS' });
      empty.createEl('h2', { text: '给阅读，留一点时间。' });
      empty.createEl('p', { cls: 'qrs-welcome-intro', text: '从列表中，挑一篇感兴趣的文章。' });
      const tips = [
        ['边读边记', '点击文章右上角的笔记本，在旁边打开今日日记。阅读和思考可以同时进行。'],
        ['留下有用的一段', '选中文字后，可追加到今日日记或当前笔记。也可以从右键菜单操作。'],
        ['把剪藏变成阅读', '在“来源”中添加库内文件夹，把剪藏的 Markdown 文章放进阅读器。'],
        ['找到舒服的排版', '正文右上角的字体按钮可以调整字号、行距和版心，改动立即保存。'],
        ['随时接着读', '切换频道后再回来，会恢复当前文章、列表位置和正文进度。'],
      ];
      if (this.welcomeSource !== this.source || this.welcomeTip < 0) { this.welcomeTip = (this.welcomeTip + 1) % tips.length; this.welcomeSource = this.source; }
      const tip = empty.createDiv('qrs-welcome-tip');
      const showTip = () => { tip.empty(); const [title, copy] = tips[this.welcomeTip]; tip.createDiv({ cls: 'qrs-welcome-index', text: `${String(this.welcomeTip + 1).padStart(2, '0')} / ${String(tips.length).padStart(2, '0')}   阅读小记` }); tip.createEl('h3', { text: title }); tip.createEl('p', { text: copy }); };
      showTip();
      empty.createEl('button', { cls: 'qrs-welcome-next', text: '下一则 →' }).onclick = () => { this.welcomeTip = (this.welcomeTip + 1) % tips.length; showTip(); };
      if (!Platform.isMobileApp) {
        const keys = empty.createDiv('qrs-welcome-keys');
        for (const [key, label] of [['J / K', '下篇 / 上篇'], ['[', '收起列表'], ['/', '搜索文章']]) { const item = keys.createSpan(); item.createEl('kbd', { text: key }); item.createSpan({ text: label }); }
      }
      return;
    }
    const toolbar = this.reader.createDiv('qrs-reader-toolbar');
    this.addIconButton(toolbar, this.focused ? 'panel-left-open' : 'panel-left-close', '显示或收起文章列表 [', () => this.toggleFocus());
    const modeId = `${this.appearanceId}-mode`; toolbar.createEl('label', { cls: 'qrs-visually-hidden', text: '阅读版本', attr: { for: modeId } });
    const select = toolbar.createEl('select', { cls: 'qrs-mode-select', attr: { id: modeId, 'data-qrs-field': '阅读版本' } });
    for (const [mode, label] of Object.entries(modeLabels).filter(([mode]) => (bundle.entry.origin !== 'local' && bundle.entry.origin !== 'vault') || mode === 'original')) select.createEl('option', { value: mode, text: label });
    select.disabled = bundle.entry.origin === 'local' || bundle.entry.origin === 'vault';
    select.value = this.mode; select.onchange = () => { this.mode = modeSchema.parse(select.value); this.renderReader(); };
    const nav = toolbar.createDiv('qrs-reader-nav');
    this.addIconButton(nav, 'chevron-up', '上一篇 K', () => this.navigate(-1));
    this.addIconButton(nav, 'chevron-down', '下一篇 J', () => this.navigate(1));
    const actions = toolbar.createDiv('qrs-actions');
    const appearance = this.addIconButton(actions, 'type', '阅读设置', () => { this.appearanceOpen = !this.appearanceOpen; this.renderReader(true); });
    appearance.setAttribute('aria-expanded', String(this.appearanceOpen)); appearance.setAttribute('aria-controls', this.appearanceId);
    const favorite = !!this.plugin.state.favorites[bundle.entry.id];
    const bookmark = this.addIconButton(actions, 'bookmark', favorite ? '取消收藏' : '收藏文章', () => this.run(async () => {
      if (favorite) delete this.plugin.state.favorites[bundle.entry.id]; else this.plugin.state.favorites[bundle.entry.id] = bundle;
      await this.plugin.persist(); this.renderReader(true); this.renderList();
    }));
    bookmark.setAttribute('aria-pressed', String(favorite)); bookmark.toggleClass('is-bookmarked', favorite);
    const read = this.plugin.state.readIds.includes(bundle.entry.id);
    const readButton = this.addIconButton(actions, read ? 'circle-check' : 'circle', read ? '标为未读' : '标为已读', () => this.run(async () => {
      const ids = this.plugin.state.readIds.filter(id => id !== bundle.entry.id);
      this.plugin.state.readIds = read ? ids : [...ids, bundle.entry.id].slice(-5000);
      await this.plugin.persist(); this.renderReader(true); this.renderList();
    }));
    readButton.setAttribute('aria-pressed', String(read));
    this.addIconButton(actions, 'notebook-pen', '记入文章笔记', () => this.noteCurrent());

    // AI Summary Toolbar Button
    const hasSummary = !!bundle.entry.aiSummary;
    const isThisSummarizing = this.summarizingEntryId === bundle.entry.id;
    const aiBtn = this.addIconButton(
      actions,
      'sparkles',
      isThisSummarizing ? 'AI 正在提炼总结…' : hasSummary ? 'AI 总结 (已生成)' : '生成 AI 总结',
      () => {
        if (hasSummary && this.summaryCollapsed) {
          this.summaryCollapsed = false;
          this.renderReader(false);
        } else {
          void this.triggerAiSummary(bundle, hasSummary);
        }
      }
    );
    if (isThisSummarizing) aiBtn.addClass('is-loading');
    if (hasSummary) aiBtn.addClass('has-summary');

    // Reading Notes & Export
    const notesCount = this.getHighlights().length;
    const notesBtn = actions.createEl('button', {
      cls: `qrs-icon qrs-notes-toolbar-btn${notesCount > 0 ? ' has-notes' : ''}`,
      attr: { 'data-qrs-label': '阅读笔记与导出' },
    });
    setIcon(notesBtn, 'highlighter');
    notesBtn.createSpan({ cls: 'qrs-visually-hidden', text: '阅读笔记与导出' });
    notesBtn.createSpan({ cls: 'qrs-notes-badge', text: notesCount > 0 ? String(notesCount) : '' });
    notesBtn.onclick = (e) => {
      const highlights = this.getHighlights();
      const menu = new Menu();
      if (highlights.length > 0) {
        menu.addItem(item => {
          item.setTitle(`导出 ${highlights.length} 条笔记到 Markdown`)
            .setIcon('file-output')
            .onClick(async () => {
              try {
                const file = await this.plugin.exportArticleNotes(bundle.entry, highlights);
                new Notice(`读书笔记已导出至：${file.path}`);
                await this.app.workspace.getLeaf(false).openFile(file);
              } catch (err) {
                new Notice(err instanceof Error ? err.message : '导出笔记失败');
              }
            });
        });
        menu.addItem(item => {
          item.setTitle('清空本篇所有划线与笔记')
            .setIcon('trash-2')
            .onClick(async () => {
              delete this.plugin.state.highlights[bundle.entry.id];
              await this.plugin.persist();
              this.renderReader(false);
              new Notice('已清空本篇笔记。');
            });
        });
      } else {
        menu.addItem(item => {
          item.setTitle('暂无划线或笔记（选中文本可划线）')
            .setIcon('info')
            .setDisabled(true);
        });
      }
      const rect = notesBtn.getBoundingClientRect();
      menu.showAtPosition({ x: rect.left, y: rect.bottom });
    };

    const more = this.addIconButton(actions, 'ellipsis', '更多文章操作', () => {
      const menu = new Menu(); const link = safeUrl(bundle.entry.link || '');
      if (bundle.entry.origin === 'vault' && bundle.entry.markdownPath) menu.addItem(item => item.setTitle('打开源文件').setIcon('file-text').onClick(() => {
        void this.app.workspace.openLinkText(bundle.entry.markdownPath!, '', true);
      }));
      if (link) menu.addItem(item => item.setTitle('在浏览器打开原文').setIcon('external-link').onClick(() => { this.contentEl.win.open(link, '_blank', 'noopener,noreferrer'); }));
      menu.addItem(item => item.setTitle('重新加载文章').setIcon('refresh-cw').onClick(() => { void this.openArticle(bundle.entry); }));
      menu.addItem(item => item.setTitle('选择频道').setIcon('rss').onClick(() => this.pickChannel()));
      const rect = more.getBoundingClientRect(); menu.showAtPosition({ x: rect.left, y: rect.bottom });
    });
    if (this.appearanceOpen) this.renderAppearanceSettings(toolbar);
    if (previous) { this.reader.append(previous); this.reader.scrollTop = scroll; this.restoreOffsets(); return; }
    const article = this.reader.createEl('article', { cls: 'qrs-article' });
    article.createEl('h1', { text: titleOf(bundle.entry) });
    if (this.message) article.createDiv({ cls: 'qrs-feedback', text: this.message, attr: { role: 'status' } });
    this.renderAiSummarySection(article, bundle);
    try {
      if (bundle.entry.origin === 'vault' && bundle.entry.markdown != null) {
        const prose = article.createDiv('qrs-prose');
        this.markdownComponent = new Component(); this.markdownComponent.load();
        void MarkdownRenderer.render(this.app, bundle.entry.markdown, prose, bundle.entry.markdownPath || '', this.markdownComponent)
          .then(async () => {
            await prepareMarkdownImageDrags(this.app, this.plugin.images, prose, bundle.entry.markdownPath || '');
            this.setupHighlightsInProse(prose);
          })
          .catch(() => { prose.setText('Markdown 无法显示，请打开源文件。'); });
      } else {
        const fragment = articleFragment(bundle, this.mode, article.ownerDocument, this.plugin.state.settings.remoteImages);
        if (fragment) {
          this.prepareImages(fragment);
          const prose = article.createDiv('qrs-prose');
          prose.append(fragment);
          this.setupHighlightsInProse(prose);
        } else {
          article.createDiv({ cls: 'qrs-empty', text: this.articleLoading ? '正在获取正文…' : `${modeLabels[this.mode]}暂无正文。可以切换版本，或从“更多”中打开原文。` });
        }
      }
    } catch { article.createDiv({ cls: 'qrs-empty', text: '正文无法显示，请打开原文阅读。' }); }
    this.reader.scrollTop = scroll; this.restoreOffsets();
  }

  private async triggerAiSummary(bundle: Bundle | null = this.bundle, force = false) {
    if (!bundle) return;
    const settings = this.plugin.state.settings;
    if (!settings.aiApiKey) {
      new Notice('请先在插件设置「AI 总结」中配置 API Key。', 4000);
      this.plugin.openSettings();
      return;
    }

    if (!force && bundle.entry.aiSummary && this.summarizingEntryId !== bundle.entry.id) {
      return;
    }

    const title = titleOf(bundle.entry);
    const content = extractBundleText(bundle, this.mode);
    if (!content || content.length < 20) {
      new Notice('文章正文内容过少，无法生成 AI 总结。');
      return;
    }

    this.summarizingEntryId = bundle.entry.id;
    this.summaryError = null;
    this.summaryErrorEntryId = null;
    this.summaryCollapsed = false;
    this.renderReader(false);

    try {
      const summary = await generateArticleSummary(
        title,
        content,
        {
          apiUrl: settings.aiApiUrl,
          apiKey: settings.aiApiKey,
          model: settings.aiModel,
          prompt: settings.aiPrompt,
        }
      );

      bundle.entry.aiSummary = summary;
      this.plugin.remember(bundle);

      for (const sub of this.plugin.state.subscriptions) {
        const item = sub.entries.find(e => e.id === bundle.entry.id);
        if (item) item.aiSummary = summary;
      }
      await this.plugin.persist();
      new Notice('✨ AI 深度总结生成完成！');
    } catch (err) {
      this.summaryError = err instanceof Error ? err.message : String(err);
      this.summaryErrorEntryId = bundle.entry.id;
      new Notice(`AI 总结失败: ${this.summaryError}`, 5000);
    } finally {
      this.summarizingEntryId = null;
      this.renderReader(false);
    }
  }

  private copySummary(bundle: Bundle) {
    if (!bundle.entry.aiSummary) return;
    const text = `【${titleOf(bundle.entry)}】AI 深度总结\n\n${bundle.entry.aiSummary}\n\n原文链接：${bundle.entry.link || ''}`;
    void navigator.clipboard.writeText(text).then(() => {
      new Notice('AI 总结已复制到剪贴板。');
    }).catch(() => {
      new Notice('复制失败，请手动选择复制。');
    });
  }

  private async noteSummary(bundle: Bundle) {
    if (!bundle.entry.aiSummary) return;
    try {
      const excerpt = `> 🤖 **AI 深度洞察与总结**：\n\n${bundle.entry.aiSummary}\n\n`;
      const result = await this.plugin.appendToDailyNote(bundle.entry, excerpt, this.mode);
      new Notice(result.added ? `已追加 AI 总结至文章笔记：${result.file.basename}` : `文章笔记中已有该总结：${result.file.basename}`);
    } catch (err) {
      new Notice(err instanceof Error ? err.message : '写入文章笔记失败。');
    }
  }

  private renderAiSummarySection(article: HTMLElement, bundle: Bundle) {
    const isSummarizing = this.summarizingEntryId === bundle.entry.id;
    const hasError = this.summaryError && this.summaryErrorEntryId === bundle.entry.id;
    const hasSummary = !!bundle.entry.aiSummary;

    if (isSummarizing) {
      const card = article.createDiv({ cls: 'qrs-ai-summary-card is-loading' });
      const header = card.createDiv('qrs-ai-card-header');
      const titleWrap = header.createDiv('qrs-ai-card-title');
      setIcon(titleWrap.createSpan('qrs-ai-icon'), 'sparkles');
      titleWrap.createSpan({ text: 'AI 深度总结' });
      titleWrap.createSpan({ cls: 'qrs-ai-model-tag', text: this.plugin.state.settings.aiModel || 'deepseek' });

      const loadingEl = card.createDiv('qrs-ai-loading-indicator');
      const spinner = loadingEl.createSpan('qrs-ai-spinner');
      setIcon(spinner, 'loader-2');
      loadingEl.createSpan({ text: '正在深入研读文章并提炼核心洞察与要点…' });
      return;
    }

    if (hasError) {
      const card = article.createDiv({ cls: 'qrs-ai-summary-card is-error' });
      const header = card.createDiv('qrs-ai-card-header');
      const titleWrap = header.createDiv('qrs-ai-card-title');
      setIcon(titleWrap.createSpan('qrs-ai-icon'), 'alert-circle');
      titleWrap.createSpan({ text: 'AI 总结生成失败' });

      card.createDiv({ cls: 'qrs-ai-error-msg', text: this.summaryError || '未知错误' });
      const actions = card.createDiv('qrs-ai-error-actions');
      const retryBtn = actions.createEl('button', { cls: 'qrs-ai-btn', text: '重新尝试' });
      retryBtn.onclick = () => void this.triggerAiSummary(bundle, true);
      return;
    }

    if (hasSummary) {
      const card = article.createDiv({ cls: 'qrs-ai-summary-card' });
      const header = card.createDiv('qrs-ai-card-header');
      const titleWrap = header.createDiv('qrs-ai-card-title');
      setIcon(titleWrap.createSpan('qrs-ai-icon'), 'sparkles');
      titleWrap.createSpan({ text: 'AI 深度总结' });
      titleWrap.createSpan({ cls: 'qrs-ai-model-tag', text: this.plugin.state.settings.aiModel || 'deepseek' });

      const btnGroup = header.createDiv('qrs-ai-card-actions');

      const toggleBtn = btnGroup.createEl('button', {
        cls: 'qrs-ai-card-btn',
        attr: { 'data-qrs-label': this.summaryCollapsed ? '展开总结' : '收起总结' },
      });
      setIcon(toggleBtn, this.summaryCollapsed ? 'chevron-down' : 'chevron-up');
      toggleBtn.onclick = () => {
        this.summaryCollapsed = !this.summaryCollapsed;
        this.renderReader(false);
      };

      const copyBtn = btnGroup.createEl('button', {
        cls: 'qrs-ai-card-btn',
        attr: { 'data-qrs-label': '复制总结' },
      });
      setIcon(copyBtn, 'copy');
      copyBtn.onclick = () => this.copySummary(bundle);

      const noteBtn = btnGroup.createEl('button', {
        cls: 'qrs-ai-card-btn',
        attr: { 'data-qrs-label': '追加到文章笔记' },
      });
      setIcon(noteBtn, 'notebook-pen');
      noteBtn.onclick = () => void this.noteSummary(bundle);

      const regenBtn = btnGroup.createEl('button', {
        cls: 'qrs-ai-card-btn',
        attr: { 'data-qrs-label': '重新生成' },
      });
      setIcon(regenBtn, 'refresh-cw');
      regenBtn.onclick = () => void this.triggerAiSummary(bundle, true);

      if (!this.summaryCollapsed) {
        const body = card.createDiv('qrs-ai-card-body');
        void MarkdownRenderer.render(this.app, bundle.entry.aiSummary!, body, '', this);
      }
      return;
    }

    // No summary yet: show prompt bar
    const promptBar = article.createDiv('qrs-ai-prompt-bar');
    const genBtn = promptBar.createEl('button', { cls: 'qrs-ai-prompt-btn' });
    setIcon(genBtn.createSpan('qrs-ai-icon'), 'sparkles');
    genBtn.createSpan({ text: '生成本篇 AI 深度总结' });
    genBtn.onclick = () => void this.triggerAiSummary(bundle, true);
  }

  private setupHighlightsInProse(prose: HTMLElement) {
    const highlights = this.getHighlights();
    restoreHighlightsInContainer(prose, highlights);

    // Event delegation on mark click
    prose.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const mark = target.closest('mark.qrs-hl') as HTMLElement;
      if (!mark) return;
      const hlId = mark.dataset.hlId;
      if (!hlId) return;
      const hl = this.getHighlights().find(h => h.id === hlId);
      if (hl) {
        e.stopPropagation();
        this.openHighlightCard(mark, hl);
      }
    });

    // Double click to zoom image
    prose.addEventListener('dblclick', (e) => {
      const target = e.target as HTMLElement;
      const img = target.closest('img') as HTMLImageElement;
      if (!img) return;
      const src = img.getAttribute('src') || img.dataset.qrsImage;
      if (!src) return;
      e.stopPropagation();
      e.preventDefault();
      this.openImageModal(src, img.getAttribute('alt') || '');
    });
  }
  private renderAppearanceSettings(anchor: HTMLElement) {
    const settings = this.plugin.state.settings;
    const headingId = `${this.appearanceId}-heading`;
    const panel = anchor.createEl('section', { cls: 'qrs-reading-settings', attr: { id: this.appearanceId, 'aria-labelledby': headingId } });
    const header = panel.createDiv('qrs-reading-settings-head'); header.createEl('strong', { text: '阅读设置', attr: { id: headingId } });
    const fields = panel.createDiv('qrs-reading-settings-fields');
    const row = (label: string) => { const el = fields.createEl('label', { cls: 'qrs-reading-setting' }); el.createSpan({ text: label }); return el; };
    const fontRow = row('字体');
    const font = fontRow.createEl('select', { attr: { 'data-qrs-field': '正文字体' } });
    for (const choice of selectableFonts.concat(readingFonts.filter(f => f.id === settings.fontFamily && !selectableFonts.includes(f)))) font.createEl('option', { value: choice.id, text: choice.name });
    font.value = settings.fontFamily;
    const customRow = row('设备字体名称');
    const custom = customRow.createEl('input', { type: 'text', value: settings.customFont, placeholder: '例如 PingFang SC' });
    customRow.hidden = settings.fontFamily !== 'custom';
    custom.oninput = () => { settings.customFont = custom.value.slice(0, 200); this.applyAppearance(); this.run(() => this.plugin.persist()); };
    const sizeRow = row('字号'); const sizeValue = sizeRow.createEl('output', { text: `${settings.fontSize} px` });
    const size = sizeRow.createEl('input', { type: 'range', value: String(settings.fontSize), attr: { min: '14', max: '32', step: '1', 'data-qrs-field': '正文字号' } });
    const heightRow = row('行距'); const heightValue = heightRow.createEl('output', { text: `${settings.lineHeight.toFixed(1)} 倍` });
    const height = heightRow.createEl('input', { type: 'range', value: String(settings.lineHeight), attr: { min: '1.5', max: '2.4', step: '0.1', 'data-qrs-field': '正文行距' } });
    const widthRow = row('版心宽度');
    const width = widthRow.createEl('select', { attr: { 'data-qrs-field': '正文宽度' } });
    for (const [value, label] of [['28', '紧凑 · 28 字'], ['36', '适中 · 36 字'], ['44', '宽松 · 44 字']] as const) width.createEl('option', { value, text: label });
    width.value = String(settings.lineWidth);
    const update = () => { sizeValue.setText(`${settings.fontSize} px`); heightValue.setText(`${settings.lineHeight.toFixed(1)} 倍`); this.applyAppearance(); };
    font.onchange = () => { settings.fontFamily = readingFontSchema.parse(font.value); customRow.hidden = settings.fontFamily !== 'custom'; update(); this.run(() => this.plugin.persist()); };
    size.oninput = () => { settings.fontSize = Number(size.value); update(); this.run(() => this.plugin.persist()); }; size.onchange = () => this.run(() => this.plugin.persist());
    height.oninput = () => { settings.lineHeight = Number(height.value); update(); this.run(() => this.plugin.persist()); }; height.onchange = () => this.run(() => this.plugin.persist());
    width.onchange = () => { settings.lineWidth = Number(width.value) as 28 | 36 | 44; update(); this.run(() => this.plugin.persist()); };
    panel.onkeydown = event => { if (event.key === 'Escape' && !event.isComposing) { event.preventDefault(); event.stopPropagation(); this.appearanceOpen = false; this.renderReader(true); } };
  }
}

class ImageModal extends Modal {
  constructor(app: any, private src: string, private alt: string) {
    super(app);
  }
  onOpen() {
    this.modalEl.addClass('qrs-image-modal');
    this.contentEl.empty();
    const wrapper = this.contentEl.createDiv('qrs-image-modal-wrap');
    const img = wrapper.createEl('img', {
      attr: {
        src: this.src,
        alt: this.alt || '放大查看图片',
      },
    });
    // Click anywhere on wrapper or image to close
    wrapper.onclick = () => this.close();
  }
}
