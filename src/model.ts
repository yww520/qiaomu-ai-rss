import { z } from 'zod';

export const modeSchema = z.enum(['rewrite', 'translation', 'original']);
export type Mode = z.infer<typeof modeSchema>;
export const modeLabels: Record<Mode, string> = { rewrite: '乔木改写', translation: '中文翻译', original: '原文' };
export const readingFontSchema = z.enum(['serif', 'sans', 'sourceHanSerif', 'sourceHanSans', 'wenkai', 'zhenkai', 'fangsong', 'custom']);
export type ReadingFont = z.infer<typeof readingFontSchema>;
const optionalText = z.string().nullish();
export const rewriteSchema = z.object({ title: optionalText, body: z.string() });
export const translationSchema = z.object({
  titleZh: optionalText, summaryZh: optionalText,
  content: z.array(z.object({ source: optionalText, target: optionalText, sourceHtml: optionalText, targetHtml: optionalText })).nullish(),
});
export const aiChatMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  createdAt: z.number().optional(),
});
export type AiChatMessage = z.infer<typeof aiChatMessageSchema>;
export const entrySchema = z.object({
  id: z.string().min(1), sourceId: z.string(), origin: z.enum(['local', 'qiaomu', 'vault']).optional(), sourceName: optionalText, title: z.string(), titleZh: optionalText,
  markdownPath: optionalText, markdown: optionalText,
  link: optionalText, author: optionalText, published: optionalText, publishedTs: z.number().nullish(),
  summary: optionalText, summaryZh: optionalText, aiSummary: optionalText, aiChat: z.array(aiChatMessageSchema).nullish(), content: optionalText, image: optionalText,
  rewrite: rewriteSchema.nullish(),
  readStatus: optionalText,
  category: optionalText,
});
export type Entry = z.infer<typeof entrySchema>;
export const sourceSchema = z.object({ id: z.string(), name: z.string(), category: optionalText, enabled: z.boolean().optional() });
export type Source = z.infer<typeof sourceSchema>;
export const bundleSchema = z.object({ entry: entrySchema, rewrite: rewriteSchema.nullable(), translation: translationSchema.nullable(), fetchedAt: z.number() });
export type Bundle = z.infer<typeof bundleSchema>;
export const pageSchema = z.object({ entries: z.array(entrySchema), hasMore: z.boolean().optional(), nextCursor: z.string().nullish() });
export const subscriptionSchema = z.object({
  id: z.string(), url: z.string(), name: z.string(), group: z.string().default(''),
  entries: z.array(entrySchema).default([]), updatedAt: z.number().default(0), error: z.string().default(''),
});
export type Subscription = z.infer<typeof subscriptionSchema>;
export const channelStateSchema = z.object({
  entries: z.array(entrySchema), bundle: bundleSchema.nullable(), mode: modeSchema,
  filter: z.enum(['all', 'unread', 'favorites']), query: z.string(), unread: z.array(z.string()),
  cursor: z.string(), hasMore: z.boolean(), listTop: z.number().nonnegative(), readerTop: z.number().nonnegative(),
  articlePending: z.boolean(),
});
export type ChannelState = z.infer<typeof channelStateSchema>;
export const highlightStyleSchema = z.enum(['highlight', 'underline', 'bold']);
export type HighlightStyle = z.infer<typeof highlightStyleSchema>;

export const highlightColorSchema = z.enum(['yellow', 'green', 'blue', 'purple', 'red', 'orange']);
export type HighlightColor = z.infer<typeof highlightColorSchema>;

export const highlightSchema = z.object({
  id: z.string(),
  entryId: z.string(),
  text: z.string(),
  style: highlightStyleSchema.default('highlight'),
  color: highlightColorSchema.default('yellow'),
  note: z.string().default(''),
  createdAt: z.number().default(0),
});
export type Highlight = z.infer<typeof highlightSchema>;

export const noteNamingPatternSchema = z.enum(['dateTitle', 'titleDate', 'title', 'date']);
export type NoteNamingPattern = z.infer<typeof noteNamingPatternSchema>;
export const noteNamingPatternLabels: Record<NoteNamingPattern, string> = {
  dateTitle: '日期 - 原文标题（默认推荐，例如：2026-09-09 - 文章标题）',
  titleDate: '原文标题 - 日期（例如：文章标题 - 2026-09-09）',
  title: '仅原文标题（例如：文章标题）',
  date: '仅日期（例如：2026-09-09，多篇文章合并追加到每日日记）',
};

export const noteHierarchySchema = z.enum(['source', 'date', 'sourceDate', 'none']);
export type NoteHierarchy = z.infer<typeof noteHierarchySchema>;
export const noteHierarchyLabels: Record<NoteHierarchy, string> = {
  source: '按来源/公众号归类（默认推荐，例如：notes/公众号名称/文章.md）',
  date: '按月份归类（例如：notes/2026-09/文章.md）',
  sourceDate: '按来源与月份归类（例如：notes/公众号名称/2026-09/文章.md）',
  none: '直接平铺在笔记目录（例如：notes/文章.md）',
};

export const stateSchema = z.object({
  settings: z.object({
    baseUrl: z.string().default('https://rss.qiaomu.ai'), folder: z.string().default('Qiaomu RSS'),
    noteFolder: z.string().default('Qiaomu RSS/notes'),
    defaultMode: modeSchema.default('rewrite'), remoteImages: z.boolean().default(true), listWidth: z.number().min(220).max(520).default(300),
    fontSize: z.number().int().min(14).max(32).default(19), customFont: z.string().max(200).catch('').default(''), fontFamily: readingFontSchema.default('fangsong'),
    lineHeight: z.number().min(1.5).max(2.4).default(1.9), lineWidth: z.union([z.literal(28), z.literal(36), z.literal(44)]).default(36),
    selectionPopup: z.boolean().default(true), markdownFolders: z.array(z.string()).default([]),
    lastSource: z.string().max(300).default(''),
    weMpServerUrl: z.string().default('http://43.156.114.156:8001'),
    weMpToken: z.string().default(''),
    aiApiUrl: z.string().default('https://api.deepseek.com/v1'),
    aiApiKey: z.string().default(''),
    aiModel: z.string().default('deepseek-chat'),
    aiPrompt: z.string().default(''),
    noteNamingPattern: noteNamingPatternSchema.default('dateTitle'),
    noteHierarchy: noteHierarchySchema.default('source'),
  }).default({ baseUrl: 'https://rss.qiaomu.ai', folder: 'Qiaomu RSS', noteFolder: 'Qiaomu RSS/notes', defaultMode: 'rewrite', remoteImages: true, listWidth: 300,
    fontSize: 19, fontFamily: 'fangsong', customFont: '', lineHeight: 1.9, lineWidth: 36, lastSource: '', selectionPopup: true, markdownFolders: [],
    weMpServerUrl: 'http://43.156.114.156:8001', weMpToken: '',
    aiApiUrl: 'https://api.deepseek.com/v1', aiApiKey: '', aiModel: 'deepseek-chat', aiPrompt: '',
    noteNamingPattern: 'dateTitle', noteHierarchy: 'source' }),
  readIds: z.array(z.string()).default([]), favorites: z.record(z.string(), bundleSchema).default({}),
  entries: z.array(entrySchema).default([]), sources: z.array(sourceSchema).default([]),
  subscriptions: z.array(subscriptionSchema).default([]),
  channelStates: z.record(z.string(), channelStateSchema).catch({}).default({}),
  savedArticles: z.record(z.string(), bundleSchema).default({}),
  highlights: z.record(z.string(), z.array(highlightSchema)).catch({}).default({}),
  deletedIds: z.array(z.string()).catch([]).default([]),
  cache: z.record(z.string(), bundleSchema).default({}), updatedAt: z.number().default(0),
});
export type State = z.infer<typeof stateSchema>;
export function initialState(data: unknown): State { return stateSchema.parse(data ?? {}); }
export function titleOf(entry: Entry): string { return entry.titleZh?.trim() || entry.title; }
export function canonicalEntryKey(entry?: Pick<Entry, 'id' | 'link' | 'title'> | null): string {
  if (!entry) return '';
  if (entry.link) {
    try {
      const u = new URL(entry.link);
      if (u.hostname.includes('mp.weixin.qq.com')) {
        if (u.pathname.startsWith('/s/')) {
          return `wx:${u.pathname}`;
        }
        const biz = u.searchParams.get('__biz');
        const mid = u.searchParams.get('mid');
        const idx = u.searchParams.get('idx');
        const sn = u.searchParams.get('sn');
        if (biz && mid && idx && sn) {
          return `wx:${biz}:${mid}:${idx}:${sn}`;
        }
      }
      const trackingKeys = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'chksm', 'scene', 'subscene', 'sessionid', 'clicktime', 'enterid', 'ascene', 'devicetype', 'version', 'nettype', 'abtest_cookie', 'lang', 'exportkey', 'pass_ticket', 'wechat_redirect'];
      for (const k of trackingKeys) {
        u.searchParams.delete(k);
      }
      u.hash = '';
      const cleanPath = u.pathname.replace(/\/$/, '') || '/';
      const search = u.searchParams.toString() ? `?${u.searchParams.toString()}` : '';
      return `url:${u.origin}${cleanPath}${search}`;
    } catch {
      return `link:${entry.link.trim()}`;
    }
  }
  return `id:${entry.id}`;
}
export function deduplicateEntriesList(entries: Entry[], deletedIds?: string[]): Entry[] {
  const deleted = new Set(deletedIds || []);
  const map = new Map<string, Entry>();
  for (const entry of entries) {
    if (deleted.has(entry.id)) continue;
    const key = canonicalEntryKey(entry);
    if (deleted.has(key)) continue;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, entry);
    } else {
      const aLen = existing.content?.length || 0;
      const bLen = entry.content?.length || 0;
      const chosen = bLen > aLen ? { ...entry } : { ...existing };
      const other = bLen > aLen ? existing : entry;
      if (!chosen.aiSummary && other.aiSummary) chosen.aiSummary = other.aiSummary;
      if (!chosen.aiChat?.length && other.aiChat?.length) chosen.aiChat = other.aiChat;
      map.set(key, chosen);
    }
  }
  return Array.from(map.values()).sort((a, b) => (b.publishedTs || 0) - (a.publishedTs || 0));
}
export function safeUrl(value: string, base?: string): string | null {
  try {
    let cleanVal = value;
    // Fix WeRead export bug where WeChat article short tokens have '_' converted to '~'
    if (cleanVal.includes('mp.weixin.qq.com/s/')) {
      cleanVal = cleanVal.replace(/(mp\.weixin\.qq\.com\/s\/[A-Za-z0-9_-]*)~([A-Za-z0-9_~-]*)/g, '$1_$2');
      // In case there are multiple tildes in the URL token
      while (cleanVal.includes('mp.weixin.qq.com/s/') && cleanVal.includes('~')) {
        cleanVal = cleanVal.replace(/(mp\.weixin\.qq\.com\/s\/[^?#]*?)~/g, '$1_');
      }
    }
    const url = new URL(cleanVal, base);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
export function serviceUrl(value: string): string {
  const url = new URL(value.trim());
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw new Error('请输入 HTTPS 服务地址，不包含路径、账号或查询参数。');
  }
  return url.origin;
}
export function folderPath(value: string): string {
  const segments = value.trim().replace(/\\/g, '/').split('/');
  if (!segments.length || segments.some(s => !s || s.startsWith('.') || /[:*?"<>|]/.test(s) || [...s].some(c => c.charCodeAt(0) < 32))) {
    throw new Error('请输入库内文件夹名称，不包含隐藏目录、空段或特殊字符。');
  }
  return segments.join('/');
}
export function withServiceOrigin(state: State, baseUrl: string): State {
  return initialState({ savedArticles: state.savedArticles, settings: { ...state.settings, baseUrl: serviceUrl(baseUrl) }, subscriptions: state.subscriptions,
    favorites: Object.fromEntries(Object.entries(state.favorites).filter(([, bundle]) => bundle.entry.origin === 'local' || bundle.entry.origin === 'vault')),
    cache: Object.fromEntries(Object.entries(state.cache).filter(([, bundle]) => bundle.entry.origin === 'local' || bundle.entry.origin === 'vault')),
    readIds: state.readIds.filter(id => id.startsWith('local-') || id.startsWith('vault:')),
    deletedIds: state.deletedIds || [] });
}
