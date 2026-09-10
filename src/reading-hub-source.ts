import { TFile, TFolder, type App } from 'obsidian';
import { safeUrl, type Entry, type Bundle } from './model';

export const READING_HUB_PREFIX = 'reading-hub:';

export interface ReadingHubViewDef {
  id: string;
  name: string;
  icon: string;
  subtitle: string;
}

export const READING_HUB_VIEWS: ReadingHubViewDef[] = [
  { id: 'reading-hub:today', name: '🎯 今日看什么', icon: 'sparkles', subtitle: '近 3 天新入库材料' },
  { id: 'reading-hub:inbox', name: '📥 Inbox 待处理', icon: 'inbox', subtitle: '待初筛材料池' },
  { id: 'reading-hub:research', name: '🔬 研究报告', icon: 'flask-conical', subtitle: '深度研究与纪要' },
  { id: 'reading-hub:screen', name: '🔍 筛选发现', icon: 'search', subtitle: '快速筛选结论' },
  { id: 'reading-hub:pod2wiki', name: '🎙️ 播客纪要', icon: 'mic', subtitle: '播客转录与核心洞察' },
  { id: 'reading-hub:daily', name: '📊 日报与信号', icon: 'line-chart', subtitle: '晨报监控与 AI 信号' },
  { id: 'reading-hub:sources', name: '📚 Sources 知识库', icon: 'book-open', subtitle: '核心沉淀来源' },
  { id: 'reading-hub:picks', name: '🎯 播客选品', icon: 'disc', subtitle: '候选与已选播客' },
  { id: 'reading-hub:starred', name: '⭐ 精读清单', icon: 'star', subtitle: '标注精读的核心收藏' },
  { id: 'reading-hub:read', name: '✅ 最近已读', icon: 'check-circle-2', subtitle: '近期已读记录' },
];

export class ReadingHubSource {
  constructor(private app: App) {}

  isAvailable(): boolean {
    return !!(
      this.app.vault.getAbstractFileByPath('reading-hub.base') ||
      this.app.vault.getAbstractFileByPath('reading-hub.md') ||
      this.app.vault.getAbstractFileByPath('ai-workspace-hub')
    );
  }

  private getHubFolders(): string[] {
    return [
      'ai-workspace-hub/inbox',
      'ai-workspace-hub/output/research',
      'ai-workspace-hub/output/screen',
      'ai-workspace-hub/output/pod2wiki',
      'ai-workspace-hub/output/daily-watch',
      'ai-workspace-hub/output/ai-signal',
      'ai-workspace-hub/output/podcast-picks',
      'ai-workspace-hub/workspace/monitoring',
      'ai-workspace-hub/wiki/sources',
      'inbox',
      'wiki/sources',
    ];
  }

  private inferCategory(path: string): string {
    if (path.includes('/inbox')) return '📥 Inbox';
    if (path.includes('/research')) return '🔬 研究';
    if (path.includes('/screen')) return '🔍 筛选';
    if (path.includes('/pod2wiki')) return '🎙️ 播客';
    if (path.includes('/podcast-picks')) return '🎯 选品';
    if (path.includes('/daily-watch') || path.includes('/ai-signal') || path.includes('/monitoring')) return '📊 日报';
    if (path.includes('/wiki/sources')) return '📚 Sources';
    return '📄 笔记';
  }

  public fileToEntry(file: TFile): Entry {
    const cache = this.app.metadataCache.getFileCache(file);
    const frontmatter = cache?.frontmatter;
    const title = typeof frontmatter?.title === 'string' ? frontmatter.title : file.basename;
    const rawSource = [frontmatter?.source, frontmatter?.url, frontmatter?.link].find(
      val => typeof val === 'string' && safeUrl(val)
    ) as string | undefined;

    const readStatus = typeof frontmatter?.read_status === 'string' ? frontmatter.read_status : '未读';
    const category = this.inferCategory(file.path);

    let publishedTs = file.stat.ctime;
    if (frontmatter?.date && typeof frontmatter.date === 'string') {
      const parsed = Date.parse(frontmatter.date);
      if (!isNaN(parsed)) publishedTs = parsed;
    }

    return {
      id: 'vault:' + file.path,
      origin: 'vault',
      sourceId: 'reading-hub:all',
      sourceName: category,
      title,
      link: rawSource || null,
      markdownPath: file.path,
      publishedTs,
      readStatus,
      category,
      author: typeof frontmatter?.channel === 'string' ? frontmatter.channel : undefined,
    };
  }

  private getAllHubFiles(): TFile[] {
    const validFolders = this.getHubFolders();
    const files = this.app.vault.getMarkdownFiles().filter(file => {
      return validFolders.some(f => file.path.startsWith(f + '/') || file.path === f);
    });
    return files;
  }

  entries(viewId: string): Entry[] {
    const allFiles = this.getAllHubFiles();
    const now = Date.now();
    const threeDaysMs = 3 * 24 * 60 * 60 * 1000;
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;

    let filtered: TFile[] = [];

    switch (viewId) {
      case 'reading-hub:today':
        filtered = allFiles.filter(f => {
          const entry = this.fileToEntry(f);
          const isRecent = now - f.stat.ctime <= threeDaysMs;
          const unread = entry.readStatus !== '已读' && entry.readStatus !== '跳过';
          return isRecent && unread;
        }).sort((a, b) => b.stat.ctime - a.stat.ctime);
        break;

      case 'reading-hub:inbox':
        filtered = allFiles.filter(f => {
          const inFolder = f.path.includes('/inbox');
          const entry = this.fileToEntry(f);
          return inFolder && (entry.readStatus === '未读' || !entry.readStatus);
        }).sort((a, b) => b.stat.ctime - a.stat.ctime);
        break;

      case 'reading-hub:research':
        filtered = allFiles.filter(f => {
          const inFolder = f.path.includes('/research');
          const entry = this.fileToEntry(f);
          return inFolder && entry.readStatus !== '跳过';
        }).sort((a, b) => b.stat.mtime - a.stat.mtime);
        break;

      case 'reading-hub:screen':
        filtered = allFiles.filter(f => {
          const inFolder = f.path.includes('/screen');
          const entry = this.fileToEntry(f);
          return inFolder && entry.readStatus !== '跳过';
        }).sort((a, b) => b.stat.ctime - a.stat.ctime);
        break;

      case 'reading-hub:pod2wiki':
        filtered = allFiles.filter(f => {
          return f.path.includes('/pod2wiki');
        }).sort((a, b) => b.stat.ctime - a.stat.ctime);
        break;

      case 'reading-hub:daily':
        filtered = allFiles.filter(f => {
          return (
            f.path.includes('/daily-watch') ||
            f.path.includes('/ai-signal') ||
            f.path.includes('/monitoring')
          );
        }).sort((a, b) => b.stat.ctime - a.stat.ctime);
        break;

      case 'reading-hub:sources':
        filtered = allFiles.filter(f => {
          const inFolder = f.path.includes('/wiki/sources');
          const entry = this.fileToEntry(f);
          return inFolder && now - f.stat.ctime <= thirtyDaysMs;
        }).sort((a, b) => b.stat.ctime - a.stat.ctime);
        break;

      case 'reading-hub:picks':
        filtered = allFiles.filter(f => {
          return f.path.includes('/podcast-picks');
        }).sort((a, b) => b.stat.ctime - a.stat.ctime);
        break;

      case 'reading-hub:starred':
        filtered = allFiles.filter(f => {
          const entry = this.fileToEntry(f);
          return entry.readStatus === '精读';
        }).sort((a, b) => b.stat.ctime - a.stat.ctime);
        break;

      case 'reading-hub:read':
        filtered = allFiles.filter(f => {
          const entry = this.fileToEntry(f);
          return entry.readStatus === '已读';
        }).sort((a, b) => b.stat.mtime - a.stat.mtime);
        break;

      default:
        filtered = allFiles.sort((a, b) => b.stat.mtime - a.stat.mtime);
        break;
    }

    return filtered.map(f => {
      const e = this.fileToEntry(f);
      e.sourceId = viewId;
      return e;
    });
  }

  async updateReadStatus(markdownPath: string, newStatus: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(markdownPath);
    if (!(file instanceof TFile)) return;

    await this.app.fileManager.processFrontMatter(file, fm => {
      fm['read_status'] = newStatus;
    });
  }

  async article(entry: Entry): Promise<Bundle> {
    const file = this.app.vault.getAbstractFileByPath(entry.markdownPath || '');
    if (!(file instanceof TFile) || file.extension !== 'md') {
      throw new Error('Markdown 文件不存在或已移动。');
    }
    const body = await this.app.vault.cachedRead(file);
    const markdown = body.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '');
    const currentEntry = this.fileToEntry(file);
    currentEntry.sourceId = entry.sourceId;
    return {
      entry: { ...currentEntry, markdown },
      rewrite: null,
      translation: null,
      fetchedAt: Date.now(),
    };
  }
}
