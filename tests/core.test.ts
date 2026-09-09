// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { RssApi } from '../src/api';
import { articleFragment } from '../src/content';
import { getTimelineGroup } from '../src/timeline';
import { articleNoteUrl, appendDailyNoteLink, articleNotePath, dailyNoteLink, dailyNotePath, renderDailyNoteTemplate, sanitizeFilename } from '../src/daily-note';
import { canonicalEntryKey, deduplicateEntriesList, folderPath, initialState, withServiceOrigin, safeUrl, serviceUrl, type Bundle, type Entry } from '../src/model';
const bundle: Bundle = {
  entry: { id: 'abc123', sourceId: 'example', title: 'Title: "quotes"\n---', link: 'https://example.com/news', content: '<h2>Original</h2><p>Full text</p>' },
  rewrite: { body: '# Title\n\n**Hello** [source](/path)\n\n```dataviewjs\nthrow Error("never execute");\n```' },
  translation: { content: [{ target: '<script>literal text</script>' }, { targetHtml: '<p>中文</p>' }] }, fetchedAt: 1,
};
describe('untrusted remote content', () => {
  it('removes executable elements, handlers, CSS, embeds and unsafe URL schemes', () => {
    const value = structuredClone(bundle);
    value.entry.content = '<script>window.pwned=1</script><iframe src="https://evil.com"></iframe><style>body{display:none}</style><p id="app" style="color:red" onclick="evil()">safe</p><a href="javascript:evil()">bad</a><a href="obsidian://open?vault=private">vault</a><img src="https://example.com/tracker" onerror="evil()"><svg onload="evil()"></svg>';
    const fragment = articleFragment(value, 'original', document, false)!;
    expect(fragment.querySelector('script,iframe,style,img,svg,[id],[style],[onclick]')).toBeNull();
    expect([...fragment.querySelectorAll('a')].every(a => !a.hasAttribute('href'))).toBe(true);
    expect(fragment.textContent).toContain('safe');
  });
  it('normalizes relative links and applies image and link protections', () => {
    const value = structuredClone(bundle); value.entry.content = '<a href="/link">link</a><img src="/image.png"><img src="data:image/svg+xml,bad">';
    const fragment = articleFragment(value, 'original', document, true)!;
    expect(fragment.querySelector('a')?.href).toBe('https://example.com/link');
    expect(fragment.querySelector('a')?.rel).toContain('noopener');
    expect(fragment.querySelector('img')?.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(fragment.querySelectorAll('img')[1].hasAttribute('src')).toBe(false);
  });
  it('renders remote code fences as inert text', () => {
    const fragment = articleFragment(bundle, 'rewrite', document, false)!;
    expect(fragment.querySelector('pre code')?.textContent).toContain('never execute');
    expect(fragment.querySelector('[class]')).toBeNull();
  });
  it('escapes plain translation strings and reports missing assets', () => {
    const fragment = articleFragment(bundle, 'translation', document, false)!;
    expect(fragment.querySelector('script')).toBeNull();
    expect(fragment.textContent).toContain('<script>literal text</script>');
    expect(articleFragment({ ...bundle, rewrite: null }, 'rewrite', document, false)).toBeNull();
  });
  it('converts section wrappers and leaf elements into distinct paragraph breaks', () => {
    const value = structuredClone(bundle);
    value.entry.content = '<section data-layout-id="1"><span>第一段内容</span></section><section data-layout-id="2"><span>第二段内容</span></section>';
    const fragment = articleFragment(value, 'original', document, false)!;
    const ps = fragment.querySelectorAll('p');
    expect(ps.length).toBe(2);
    expect(ps[0].textContent).toBe('第一段内容');
    expect(ps[1].textContent).toBe('第二段内容');
  });
  it('correctly calculates timeline groups for today, yesterday, this week, last week and older', () => {
    const now = new Date(2026, 8, 23, 12, 0, 0); // Wednesday 2026-09-23
    expect(getTimelineGroup({ publishedTs: new Date(2026, 8, 23, 8, 0, 0).getTime() }, now)).toMatchObject({ key: 'today', label: '今天' });
    expect(getTimelineGroup({ publishedTs: new Date(2026, 8, 22, 18, 0, 0).getTime() }, now)).toMatchObject({ key: 'yesterday', label: '昨天' });
    expect(getTimelineGroup({ publishedTs: new Date(2026, 8, 21, 10, 0, 0).getTime() }, now)).toMatchObject({ key: 'this_week', label: '本周' });
    expect(getTimelineGroup({ publishedTs: new Date(2026, 8, 16, 10, 0, 0).getTime() }, now)).toMatchObject({ key: 'last_week', label: '上周' });
    expect(getTimelineGroup({ publishedTs: new Date(2026, 8, 1, 10, 0, 0).getTime() }, now)).toMatchObject({ key: 'this_month_earlier', label: '本月更早' });
    expect(getTimelineGroup({ publishedTs: new Date(2026, 7, 20, 10, 0, 0).getTime() }, now)).toMatchObject({ label: '8月' });
    expect(getTimelineGroup({ publishedTs: new Date(2025, 11, 20, 10, 0, 0).getTime() }, now)).toMatchObject({ label: '2025年' });
    expect(getTimelineGroup({ publishedTs: null, published: null }, now)).toMatchObject({ key: 'unknown', label: '更早' });
  });
  it('appends only a linked title to a daily note and avoids duplicates', () => {
    const entry = { ...bundle.entry, title: 'Plain title' };
    expect(dailyNoteLink(entry)).toBe('[Plain title](<https://example.com/news>)');
    const first = appendDailyNoteLink('# Daily\n', bundle.entry);
    expect(first.content).toContain('# Daily\n\n' + dailyNoteLink(bundle.entry) + '\n\n');
    expect(first.content).not.toMatch(/^- /m);
    expect(appendDailyNoteLink(first.content, bundle.entry)).toEqual({ content: first.content, added: false });
    expect(first.content).not.toContain('Full text'); expect(first.content).not.toContain('rss_id');
  });
  it('captures inert excerpts with vault-scoped internal article links', () => {
    const options = { vault: '中文 & QA', article: 'https://rss.qiaomu.ai|a/b', mode: 'rewrite' as const, excerpt: 'A paragraph\n\n- item <script> [link](evil) `code`' };
    const url = new URL(articleNoteUrl(options));
    expect(url.searchParams.get('vault')).toBe(options.vault);
    expect(articleNoteUrl(options)).not.toContain('+');
    expect(articleNoteUrl(options)).toContain('%20');
    expect(url.searchParams.get('article')).toBe(options.article);
    expect(url.searchParams.get('mode')).toBe('rewrite');
    const first = appendDailyNoteLink('', bundle.entry, options);
    expect(first.content).toContain('obsidian://qiaomu-ai-rss?');
    expect(first.content).toContain('[原文](<https://example.com/news>)');
    expect(first.content).not.toMatch(/^- /m);
    expect(first.content).not.toContain('<script>');
    expect(appendDailyNoteLink(first.content, bundle.entry, options).added).toBe(false);
    expect(appendDailyNoteLink(first.content, bundle.entry, { ...options, excerpt: 'Another paragraph' }).added).toBe(true);
  });
  it('groups A B A excerpts under one source title and preserves other notes', () => {
    const a = { article: 'a', vault: 'Qiaomu RSS QA', excerpt: 'First A' };
    let content = appendDailyNoteLink('# My note\n', bundle.entry, a).content;
    content = appendDailyNoteLink(content, { ...bundle.entry, title: 'B' }, { ...a, article: 'b', excerpt: 'First B' }).content;
    content = appendDailyNoteLink(content, bundle.entry, { ...a, excerpt: 'Second A' }).content;
    expect(content.split('obsidian://qiaomu-ai-rss?')).toHaveLength(3);
    expect(content.indexOf('Second A')).toBeLessThan(content.indexOf('First B'));
    expect(content).toContain('# My note');
    expect(appendDailyNoteLink(content, bundle.entry, { ...a, excerpt: 'Second A' }).added).toBe(false);
  });
  it('recognizes old links and repairs form-encoded vault spaces without repeating title', () => {
    const a = { article: 'a', vault: 'Qiaomu RSS QA', excerpt: 'Second' };
    const old = dailyNoteLink(bundle.entry, a).replace(/%20/g, '+') + '\n\nFirst\n\n';
    const result = appendDailyNoteLink(old, bundle.entry, a);
    expect(result.content).not.toContain('Qiaomu+RSS+QA');
    expect(result.content.split('obsidian://qiaomu-ai-rss?')).toHaveLength(2);
    expect(result.content).toContain('First\n\nSecond');
  });
  it('adds an original link to an existing grouped header without duplicating it', () => {
    const options = { article: 'a', vault: 'QA', excerpt: 'First' };
    const old = appendDailyNoteLink('', bundle.entry, options).content.replace(' · [原文](<https://example.com/news>)', '');
    const upgraded = appendDailyNoteLink(old, bundle.entry, { ...options, excerpt: 'Second' }).content;
    expect(upgraded.split('[原文]')).toHaveLength(2);
    expect(appendDailyNoteLink(upgraded, bundle.entry, options).content.split('[原文]')).toHaveLength(2);
  });
  it('removes legacy capture markers while keeping grouped excerpts and notes', () => {
    const options = { vault: 'QA', article: 'local:test', excerpt: 'First excerpt' };
    const first = appendDailyNoteLink('', bundle.entry, options).content;
    expect(first).not.toContain('qrs-article:');
    const legacy = first + '<!-- qrs-article:local%3Atest -->\n\nPersonal note\n';
    const next = appendDailyNoteLink(legacy, bundle.entry, { ...options, excerpt: 'Second excerpt' }).content;
    expect(next).not.toContain('qrs-article:');
    expect(next).toContain('Personal note');
    expect(next).toContain('First excerpt');
    expect(next).toContain('Second excerpt');
    expect(next.split('[原文]')).toHaveLength(2);
  });
  it('links local Markdown captures back to their source file without a web URL', () => {
    const entry = { ...bundle.entry, origin: 'vault' as const, link: null, markdownPath: 'Clippings/My article.md' };
    const link = dailyNoteLink(entry, { vault: 'Qiaomu RSS QA', article: 'vault:file' });
    expect(link).toContain('[原文](<obsidian://open?vault=Qiaomu%20RSS%20QA&file=Clippings%2FMy%20article.md>)');
  });
  it('respects daily-note folders, formats and common template tokens', () => {
    const now = { format: (format: string) => ({ 'YYYY/MM/DD': '2026/09/07', 'YYYY-MM-DD': '2026-09-07', 'HH:mm': '12:30' })[format] || format } as never;
    expect(dailyNotePath({ folder: 'Daily', format: 'YYYY/MM/DD', template: '' }, now)).toBe('Daily/2026/09/07.md');
    expect(renderDailyNoteTemplate('# {{title}}\n{{date}} {{time}}', '2026-09-07', now)).toBe('# 2026-09-07\n2026-09-07 12:30');
  });
  it('generates article note paths with custom naming patterns and sanitized titles', () => {
    const now = { format: (format: string) => ({ 'YYYY-MM-DD': '2026-09-09', 'YYYY-MM': '2026-09' })[format] || format } as never;
    const entry: Entry = {
      id: 'test1',
      sourceId: 's1',
      title: '大摩闭门会核心判断：现在既不是2021，也不是924 / 特别关注',
      titleZh: '大摩闭门会核心判断：现在既不是2021，也不是924 / 特别关注',
      link: 'https://mp.weixin.qq.com/s/xyz',
    };

    expect(sanitizeFilename('大摩:核心/要点? "引号" <标签> *星号* | 竖线')).toBe('大摩 核心 要点 引号 标签 星号 竖线');

    // Default: dateTitle + source hierarchy
    expect(articleNotePath({ folder: 'Qiaomu RSS/notes' }, entry, 'dateTitle', 'source', '投资作业本Pro', now))
      .toBe('Qiaomu RSS/notes/投资作业本Pro/2026-09-09 - 大摩闭门会核心判断：现在既不是2021，也不是924 特别关注.md');

    // date hierarchy (by month)
    expect(articleNotePath({ folder: 'Qiaomu RSS/notes' }, entry, 'dateTitle', 'date', '投资作业本Pro', now))
      .toBe('Qiaomu RSS/notes/2026-09/2026-09-09 - 大摩闭门会核心判断：现在既不是2021，也不是924 特别关注.md');

    // sourceDate hierarchy (source/YYYY-MM)
    expect(articleNotePath({ folder: 'Qiaomu RSS/notes' }, entry, 'dateTitle', 'sourceDate', '投资作业本Pro', now))
      .toBe('Qiaomu RSS/notes/投资作业本Pro/2026-09/2026-09-09 - 大摩闭门会核心判断：现在既不是2021，也不是924 特别关注.md');

    // Flat (no hierarchy)
    expect(articleNotePath({ folder: 'Qiaomu RSS/notes' }, entry, 'dateTitle', 'none', '投资作业本Pro', now))
      .toBe('Qiaomu RSS/notes/2026-09-09 - 大摩闭门会核心判断：现在既不是2021，也不是924 特别关注.md');

    // titleDate
    expect(articleNotePath({ folder: '' }, entry, 'titleDate', 'none', '投资作业本Pro', now))
      .toBe('大摩闭门会核心判断：现在既不是2021，也不是924 特别关注 - 2026-09-09.md');

    // date only
    expect(articleNotePath({ folder: 'Daily' }, entry, 'date', 'none', '投资作业本Pro', now))
      .toBe('Daily/2026-09-09.md');
  });
});
describe('paths and persistence', () => {
  it('rejects path traversal, hidden folders and absolute paths', () => {
    for (const value of ['../secret', '.obsidian', '/tmp', 'a//b', 'a/../b', 'C:\\x']) expect(() => folderPath(value)).toThrow();
    expect(folderPath('阅读/文章')).toBe('阅读/文章');
  });
  it('accepts HTTPS origins only, without embedded credentials', () => {
    expect(serviceUrl('https://rss.qiaomu.ai/')).toBe('https://rss.qiaomu.ai');
    for (const url of ['http://example.com', 'https://name:secret@example.com', 'https://example.com/path', 'https://example.com?token=secret']) expect(() => serviceUrl(url)).toThrow();
    expect(safeUrl('javascript:alert(1)')).toBeNull();
  });
  it('round trips favorites and cached content', () => {
    const state = initialState({ favorites: { abc123: bundle }, cache: { abc123: bundle }, readIds: ['abc123'] });
    expect(initialState(JSON.parse(JSON.stringify(state))).favorites.abc123.entry.id).toBe('abc123');
  });
  it('preserves saved article links through cache and service changes', () => {
    expect(initialState({}).savedArticles).toEqual({});
    const state = initialState({ savedArticles: { saved: bundle } });
    const restored = initialState(JSON.parse(JSON.stringify(state)));
    expect(withServiceOrigin(restored, 'https://example.com').savedArticles.saved).toEqual(bundle);
  });
  it('defaults the selection popup on and persists folder sources and opt-in', () => {
    expect(initialState({}).settings.selectionPopup).toBe(true);
    const state = initialState({ settings: { selectionPopup: true, markdownFolders: ['Clippings', 'Articles'] } });
    expect(initialState(JSON.parse(JSON.stringify(state))).settings).toMatchObject({ selectionPopup: true, markdownFolders: ['Clippings', 'Articles'] });
  });
  it('migrates and persists compact reading appearance settings', () => {
    expect(initialState({ settings: {} }).settings).toMatchObject({ fontSize: 19, fontFamily: 'fangsong', lineHeight: 1.9, lineWidth: 36 });
    const state = initialState({ settings: { fontSize: 24, fontFamily: 'sans', lineHeight: 2.2, lineWidth: 44 } });
    expect(initialState(JSON.parse(JSON.stringify(state))).settings).toMatchObject({ fontSize: 24, fontFamily: 'sans', lineHeight: 2.2, lineWidth: 44 });
  });
  it('deduplicates entries with the same canonical WeChat link or URL parameters', () => {
    const e1: Entry = { id: 'local-1', sourceId: 'src-1', title: 'Visa发布链上借贷', link: 'https://mp.weixin.qq.com/s/QT9YTiFO_fm1gs1LRvZGQg?chksm=abc&scene=21', publishedTs: 1000, content: 'short' };
    const e2: Entry = { id: 'local-2', sourceId: 'src-2', title: 'Visa发布链上借贷', link: 'https://mp.weixin.qq.com/s/QT9YTiFO_fm1gs1LRvZGQg', publishedTs: 1000, content: 'longer content here' };
    const e3: Entry = { id: 'local-3', sourceId: 'src-3', title: 'Another article', link: 'https://mp.weixin.qq.com/s/other123', publishedTs: 2000, content: 'text' };

    expect(canonicalEntryKey(e1)).toBe('wx:/s/QT9YTiFO_fm1gs1LRvZGQg');
    expect(canonicalEntryKey(e2)).toBe('wx:/s/QT9YTiFO_fm1gs1LRvZGQg');

    const result = deduplicateEntriesList([e1, e2, e3]);
    expect(result).toHaveLength(2);
    // Should keep e2 because it has longer content
    expect(result.find(r => canonicalEntryKey(r) === 'wx:/s/QT9YTiFO_fm1gs1LRvZGQg')?.id).toBe('local-2');
  });
  it('filters out deleted entries using deletedIds', () => {
    const e1: Entry = { id: 'local-1', sourceId: 'src-1', title: 'Article 1', link: 'https://mp.weixin.qq.com/s/del1', publishedTs: 1000 };
    const e2: Entry = { id: 'local-2', sourceId: 'src-1', title: 'Article 2', link: 'https://mp.weixin.qq.com/s/keep2', publishedTs: 2000 };

    const deletedIds = ['wx:/s/del1'];
    const result = deduplicateEntriesList([e1, e2], deletedIds);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('local-2');
  });
});
describe('API contract and failures', () => {
  it('uses encoded channel paths and cursor query', async () => {
    const transport = vi.fn(async () => ({ status: 200, text: '{"entries":[],"hasMore":true,"nextCursor":"next"}' }));
    const api = new RssApi('https://rss.qiaomu.ai', transport);
    await api.entries('a/b', 'x+y');
    expect(transport.mock.calls[0][0]).toBe('https://rss.qiaomu.ai/api/sources/a%2Fb/entries?limit=40&ready=rewrite&cursor=x%2By');
  });
  it('does not let remote entries impersonate vault Markdown', async () => {
    const entry = { ...bundle.entry, origin: 'vault', markdownPath: 'Secret.md', markdown: 'private' };
    const api = new RssApi('https://rss.qiaomu.ai', async () => ({ status: 200, text: JSON.stringify({ entries: [entry] }) }));
    const result = await api.entries();
    expect(result.entries[0]).toMatchObject({ origin: 'qiaomu' });
    expect(result.entries[0].markdownPath).toBeUndefined();
    expect(result.entries[0].markdown).toBeUndefined();
  });
  it('rejects HTTP and schema errors without rendering server error HTML', async () => {
    await expect(new RssApi('https://rss.qiaomu.ai', async () => ({ status: 503, text: '<secret>' })).entries()).rejects.toThrow('HTTP 503');
    await expect(new RssApi('https://rss.qiaomu.ai', async () => ({ status: 200, text: '{"entries":[{}]}' })).entries()).rejects.toThrow('格式不兼容');
  });
  it('retains usable article when an optional asset endpoint fails', async () => {
    const api = new RssApi('https://rss.qiaomu.ai', async url => url.endsWith('/rewrite') ? { status: 503, text: '' } : { status: 200, text: JSON.stringify(url.endsWith('/translation') ? { translation: null } : { entry: bundle.entry }) });
    const result = await api.article('abc123');
    expect(result.bundle.entry.id).toBe('abc123'); expect(result.warnings).toHaveLength(1);
  });
  it('times out stalled requests', async () => {
    vi.useFakeTimers();
    const api = new RssApi('https://rss.qiaomu.ai', () => new Promise(() => {}));
    const assertion = expect(api.entries()).rejects.toThrow('请求超时');
    await vi.advanceTimersByTimeAsync(20001); await assertion; vi.useRealTimers();
  });
});
