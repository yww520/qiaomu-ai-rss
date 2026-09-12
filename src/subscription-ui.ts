import { Modal, Notice, Setting, setIcon } from 'obsidian';
import { DiscoveryPanel } from './discovery-view';
import { VaultFilePicker, VaultFolderPicker, vaultSourceId } from './vault-source';
import type QiaomuRssPlugin from './main';
import { exportOpml, MAX_SUBSCRIPTIONS, parseOpml, type FeedInput } from './feeds';
import { canonicalEntryKey, type Subscription } from './model';

import { WeMpClient } from './wemp-api';

export type SubscriptionTab = 'mine' | 'explore' | 'wechat' | 'local';
export class SubscriptionManager extends Modal {
  private list!: HTMLElement;
  private message!: HTMLElement;
  private discovery?: DiscoveryPanel;
  private body!: HTMLElement;
  constructor(private plugin: QiaomuRssPlugin, private changed: () => void, private tab: SubscriptionTab = 'mine') { super(plugin.app); }
  onOpen() {
    this.setTitle('订阅管理'); this.modalEl.addClass('qrs-subscription-modal');
    const tabs = this.contentEl.createDiv({ cls: 'qrs-subscription-tabs', attr: { role: 'tablist' } });
    this.body = this.contentEl.createDiv({ cls: 'qrs-subscription-body', attr: { role: 'tabpanel', id: `qrs-sources-${crypto.randomUUID()}` } });
    const choices: [SubscriptionTab, string][] = [['mine', '我的订阅'], ['explore', '探索'], ['wechat', '微信公众号'], ['local', '本地文件夹']];
    const select = (tab: SubscriptionTab) => {
      this.tab = tab;
      for (const button of tabs.querySelectorAll('button')) { const selected = button.dataset.tab === tab; button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1; }
      this.discovery?.unload(); this.discovery = undefined; this.body.empty();
      if (tab === 'mine') this.renderMine();
      else if (tab === 'explore') { this.discovery = new DiscoveryPanel(this.body.createDiv(), this.plugin, true); this.discovery.load(); }
      else if (tab === 'wechat') this.renderWechat();
      else this.renderLocal();
    };
    for (const [tab, label] of choices) {
      const button = tabs.createEl('button', { text: label, attr: { role: 'tab', 'data-tab': tab, 'aria-controls': this.body.id } });
      button.onclick = () => select(tab);
      button.onkeydown = event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault(); const index = choices.findIndex(([id]) => id === this.tab);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? 2 : (index + (event.key === 'ArrowRight' ? 1 : 2)) % 3;
        select(choices[next][0]); (tabs.children[next] as HTMLButtonElement).focus();
      };
    }
    select(this.tab);
  }
  onClose() { this.discovery?.unload(); this.contentEl.empty(); }
  refresh() { this.discovery?.refresh(); }
  private renderLocal() {
    const add = (path: string) => {
      const settings = this.plugin.state.settings;
      if (!settings.markdownFolders.includes(path)) settings.markdownFolders.push(path);
      settings.lastSource = vaultSourceId(path);
      void this.plugin.persist().then(() => { this.plugin.resetViews(); if (this.tab === 'local' && this.body.isConnected) { this.body.empty(); this.renderLocal(); } });
    };
    const tools = this.body.createDiv('qrs-subscription-tools');
    tools.createEl('button', { text: '添加文件夹' }).onclick = () => new VaultFolderPicker(this.app, folder => add(folder.path)).open();
    tools.createEl('button', { text: '添加文件' }).onclick = () => new VaultFilePicker(this.app, file => add(file.path)).open();
    for (const path of this.plugin.state.settings.markdownFolders) {
      new Setting(this.body).setName(path === '/' ? '整个库' : path).addButton(button => button.setButtonText('移除').onClick(async () => {
        this.plugin.state.settings.markdownFolders = this.plugin.state.settings.markdownFolders.filter(value => value !== path);
        await this.plugin.persist(); this.plugin.resetViews(); if (this.tab === 'local' && this.body.isConnected) { this.body.empty(); this.renderLocal(); }
      }));
    }
    if (!this.plugin.state.settings.markdownFolders.length) this.body.createEl('p', { cls: 'qrs-subscription-help', text: '选择剪藏文件夹或笔记，在阅读器中阅读。' });
  }
  private renderWechat() {
    const settings = this.plugin.state.settings;
    const client = new WeMpClient(() => settings.weMpServerUrl, () => settings.weMpToken);

    const container = this.body.createDiv('qrs-wechat-panel');

    const statusRow = container.createDiv({ cls: 'qrs-subscription-tools' });
    const statusText = statusRow.createSpan({ text: `云端服务: ${settings.weMpServerUrl || '未配置'}` });
    const qrBtn = statusRow.createEl('button', { text: '微信扫码授权 (双通道)', cls: 'mod-cta' });
    const checkBtn = statusRow.createEl('button', { text: '测试连接' });
    const webBtn = statusRow.createEl('button', { text: '打开服务后台' });
    webBtn.onclick = () => {
      if (settings.weMpServerUrl) window.open(settings.weMpServerUrl, '_blank');
    };

    qrBtn.onclick = () => {
      new WeChatQrAuthModal(this.plugin, client, () => {
        this.body.empty();
        this.renderWechat();
      }).open();
    };

    checkBtn.onclick = async () => {
      checkBtn.disabled = true;
      checkBtn.setText('测试中…');
      const health = await client.checkHealth();
      checkBtn.disabled = false;
      checkBtn.setText('测试连接');
      if (health.ok) {
        new Notice(`We-MP-RSS 连接正常: ${health.message}`);
        statusText.setText(`云端服务: ${settings.weMpServerUrl} (在线)`);
      } else {
        new Notice(`连接失败: ${health.message}`);
        statusText.setText(`云端服务: ${settings.weMpServerUrl} (离线/失败)`);
      }
    };

    const form = container.createEl('form', { cls: 'qrs-subscription-add' });
    const input = form.createEl('input', {
      type: 'text',
      placeholder: '搜索微信公众号（如：晚点LatePost、机器之心、新智元）…',
      attr: { style: 'flex: 1;' },
    });
    const searchBtn = form.createEl('button', { text: '搜索', type: 'submit', cls: 'mod-cta' });
    const resultBox = container.createDiv({ cls: 'qrs-wechat-results' });

    // Show currently synced WeChat subscriptions
    const wechatSubs = this.plugin.state.subscriptions.filter(s => s.group === '微信公众号' || s.url.includes('/feed/'));
    if (wechatSubs.length) {
      const existingSection = container.createDiv({ cls: 'qrs-wechat-existing', attr: { style: 'margin-top: 16px;' } });
      existingSection.createEl('h4', { text: `已关注的微信公众号 (${wechatSubs.length})`, attr: { style: 'margin-bottom: 8px;' } });
      const subList = existingSection.createDiv('qrs-subscription-list');
      for (const feed of wechatSubs) {
        const row = subList.createDiv('qrs-subscription-row');
        const info = row.createDiv('qrs-subscription-info');
        info.createDiv({ cls: 'qrs-subscription-name', text: feed.name });
        info.createDiv({ cls: 'qrs-subscription-detail', text: `${feed.entries.length} 篇 · ${feed.url}` });
        
        const actions = row.createDiv({ attr: { style: 'display: flex; gap: 6px; align-items: center;' } });
        const syncBtn = actions.createEl('button', { cls: 'qrs-subscription-icon', attr: { 'data-qrs-label': `同步文章 ${feed.name}` } });
        setIcon(syncBtn, 'refresh-cw');
        syncBtn.onclick = async () => {
          syncBtn.disabled = true;
          const match = feed.url.match(/\/feed\/([^/.]+)\.xml/);
          if (match && match[1] && !match[1].startsWith('all')) {
            new Notice(`正在触发微信读书同步抓取「${feed.name}」…`);
            await client.updateMpArticles(match[1], feed.name);
          }
          await this.plugin.subscriptions.refresh([feed.id], this.contentEl.ownerDocument, true);
          const updatedCount = this.plugin.state.subscriptions.find(s => s.id === feed.id)?.entries.length || 0;
          new Notice(`「${feed.name}」已刷新，当前共 ${updatedCount} 篇文章`);
          this.body.empty();
          this.renderWechat();
          this.changed();
        };

        const remove = actions.createEl('button', { cls: 'qrs-subscription-icon', attr: { 'data-qrs-label': `取消关注 ${feed.name}` } });
        setIcon(remove, 'trash-2');
        remove.onclick = () => new RemoveSubscription(this.plugin, feed, () => { this.body.empty(); this.renderWechat(); this.changed(); }).open();
      }
    }

    const quickTools = container.createDiv({ cls: 'qrs-subscription-tools', attr: { style: 'margin-top: 14px; margin-bottom: 8px;' } });
    const addAllBtn = quickTools.createEl('button', { text: '订阅公众号全量汇总源 (All-in-One)' });
    addAllBtn.onclick = async () => {
      const allFeedUrl = `${settings.weMpServerUrl.replace(/\/$/, '')}/feed/all.xml`;
      await this.plugin.subscriptions.add(allFeedUrl, '微信公众号', this.contentEl.ownerDocument);
      new Notice('已添加微信公众号全量汇总源');
      this.body.empty();
      this.renderWechat();
      this.changed();
    };

    const importArticleBtn = quickTools.createEl('button', { text: '导入单篇微信文章链接…' });
    importArticleBtn.onclick = () => {
      new ImportWechatArticleModal(this.plugin, client, () => {
        this.body.empty();
        this.renderWechat();
        this.changed();
      }).open();
    };


    form.onsubmit = async (e) => {
      e.preventDefault();
      const kw = input.value.trim();
      if (!kw) return;
      searchBtn.disabled = true;
      searchBtn.setText('搜索中…');
      resultBox.empty();
      resultBox.createEl('p', { text: `正在云端检索「${kw}」…`, cls: 'qrs-subscription-message' });

      try {
        const accounts = await client.searchAccounts(kw);
        resultBox.empty();
        if (!accounts.length) {
          const emptyDiv = resultBox.createDiv({ cls: 'qrs-empty', attr: { style: 'padding: 12px;' } });
          emptyDiv.createEl('p', { text: `未从云端检索到「${kw}」公众号。` });
          emptyDiv.createEl('p', { text: '提示：可先登录服务后台完成微信扫码授权，或点击下方按钮直接以标准 Feed 订阅：', attr: { style: 'font-size: 0.85em; color: var(--text-muted);' } });
          const forceBtn = emptyDiv.createEl('button', { text: `以此名称订阅并加入微信公众号分组`, cls: 'mod-cta' });
          forceBtn.onclick = async () => {
            const feedUrl = `${settings.weMpServerUrl.replace(/\/$/, '')}/feed/${encodeURIComponent(kw)}.xml`;
            await this.plugin.subscriptions.add(feedUrl, '微信公众号', this.contentEl.ownerDocument);
            new Notice(`已添加公众号：${kw}`);
            this.body.empty();
            this.renderWechat();
            this.changed();
          };
          return;
        }

        for (const acc of accounts) {
          const card = resultBox.createDiv({ cls: 'qrs-subscription-row', attr: { style: 'padding: 10px 14px; margin-bottom: 8px;' } });
          const info = card.createDiv('qrs-subscription-info');
          info.createDiv({ cls: 'qrs-subscription-name', text: acc.name });
          if (acc.description) {
            info.createDiv({ cls: 'qrs-subscription-detail', text: acc.description });
          }

          const isSubscribed = this.plugin.state.subscriptions.some(s => s.name === acc.name || s.url.includes(acc.id));
          const subBtn = card.createEl('button', { text: isSubscribed ? '已关注' : '关注订阅', cls: isSubscribed ? '' : 'mod-cta' });
          if (isSubscribed) subBtn.disabled = true;

          subBtn.onclick = async () => {
            subBtn.disabled = true;
            subBtn.setText('订阅中…');
            try {
              const res = await client.subscribe(acc);
              // Wait 600ms for We-MP-RSS server to initialize the XML feed endpoint
              await new Promise(r => setTimeout(r, 600));
              await this.plugin.subscriptions.add(res.feedUrl, '微信公众号', this.contentEl.ownerDocument);
              new Notice(`已成功订阅公众号：${acc.name}`);
              subBtn.setText('已关注');
              void client.updateMpArticles(acc.fakeid || acc.id, acc.name).then(async () => {
                await this.plugin.subscriptions.refresh([], this.contentEl.ownerDocument, true);
              });
              this.changed();
            } catch (subErr) {
              const msg = subErr instanceof Error ? subErr.message : String(subErr);
              new Notice(`订阅出错: ${msg}`);
              subBtn.disabled = false;
              subBtn.setText('关注订阅');
            }
          };
        }
      } catch (err) {
        resultBox.empty();
        resultBox.createDiv({ cls: 'qrs-subscription-error', text: `检索出错: ${err instanceof Error ? err.message : String(err)}` });
      } finally {
        searchBtn.disabled = false;
        searchBtn.setText('搜索');
      }
    };
  }
  private renderMine() {
    const form = this.body.createEl('form', { cls: 'qrs-subscription-add' });
    const fieldId = crypto.randomUUID();
    form.createEl('label', { cls: 'qrs-visually-hidden', text: 'RSS 或 Atom 地址', attr: { for: `qrs-feed-${fieldId}` } });
    const url = form.createEl('input', { type: 'url', placeholder: 'https://example.com/feed.xml', attr: { id: `qrs-feed-${fieldId}`, required: '' } });
    form.createEl('label', { cls: 'qrs-visually-hidden', text: '订阅分组', attr: { for: `qrs-group-${fieldId}` } });
    const group = form.createEl('input', { type: 'text', placeholder: '分组（可选）', attr: { id: `qrs-group-${fieldId}`, maxlength: '100' } });
    const add = form.createEl('button', { text: '添加', type: 'submit', cls: 'mod-cta' });
    this.message = this.body.createDiv({ cls: 'qrs-subscription-message', attr: { role: 'status' } });
    form.onsubmit = event => {
      event.preventDefault(); add.disabled = true; this.message.setText('正在读取订阅源…');
      void this.plugin.subscriptions.add(url.value, group.value, this.contentEl.ownerDocument).then(() => {
        url.value = ''; this.message.setText('订阅已添加。'); this.renderList(); this.changed();
      }).catch((error: unknown) => { this.message.setText(error instanceof Error ? error.message : '添加失败，请重试。'); }).finally(() => { add.disabled = false; });
    };
    const tools = this.body.createDiv('qrs-subscription-tools');
    const importButton = tools.createEl('button', { text: '导入 OPML' });
    importButton.onclick = () => new OpmlImport(this.plugin, () => { this.renderList(); this.changed(); }).open();
    const exportButton = tools.createEl('button', { text: '导出 OPML' });
    exportButton.onclick = () => {
      if (!this.plugin.state.subscriptions.length) { this.message.setText('还没有可以导出的订阅。'); return; }
      void this.plugin.saveOpml(exportOpml(this.plugin.state.subscriptions)).then(path => {
        this.message.setText(`已导出到 ${path}`);
      }).catch(() => { this.message.setText('导出失败，请检查 OPML 导出文件夹。'); });
    };
    this.list = this.body.createDiv('qrs-subscription-list'); this.renderList();
    this.body.createEl('p', { cls: 'qrs-subscription-help', text: '订阅仅保存在本库。直接读取订阅网站；个人源显示原文，不调用 AI。' });
  }
  private renderList() {
    this.list.empty();
    const feeds = [...this.plugin.state.subscriptions].sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name));
    if (!feeds.length) { this.list.createDiv({ cls: 'qrs-empty', text: '添加第一个订阅，开始阅读。' }); return; }
    for (const feed of feeds) {
      const row = this.list.createDiv('qrs-subscription-row');
      const info = row.createDiv('qrs-subscription-info');
      info.createDiv({ cls: 'qrs-subscription-name', text: feed.name });
      info.createDiv({ cls: 'qrs-subscription-detail', text: `${feed.group || '未分组'} · ${new URL(feed.url).hostname} · ${feed.entries.length} 篇` });
      if (feed.error) info.createDiv({ cls: 'qrs-subscription-error', text: feed.error });
      const sync = row.createEl('button', { cls: 'qrs-subscription-icon', attr: { 'data-qrs-label': `刷新 ${feed.name}` } });
      setIcon(sync, 'refresh-cw'); sync.createSpan({ cls: 'qrs-visually-hidden', text: `刷新 ${feed.name}` });
      sync.onclick = async () => {
        sync.disabled = true;
        const match = feed.url.match(/\/feed\/([^/.]+)\.xml/);
        if (match && match[1] && !match[1].startsWith('all')) {
          new Notice(`正在触发云端抓取「${feed.name}」…`);
          const client = new WeMpClient(() => this.plugin.state.settings.weMpServerUrl, () => this.plugin.state.settings.weMpToken);
          void client.updateMpArticles(match[1]);
        }
        await this.plugin.subscriptions.refresh([feed.id], this.contentEl.ownerDocument, true);
        const updatedCount = this.plugin.state.subscriptions.find(s => s.id === feed.id)?.entries.length || 0;
        new Notice(`「${feed.name}」已刷新，当前共 ${updatedCount} 篇文章`);
        this.renderList();
        this.changed();
      };

      const edit = row.createEl('button', { cls: 'qrs-subscription-icon', attr: { 'data-qrs-label': `编辑 ${feed.name}` } });
      setIcon(edit, 'pencil'); edit.createSpan({ cls: 'qrs-visually-hidden', text: `编辑 ${feed.name}` });
      edit.onclick = () => new EditSubscription(this.plugin, feed, () => { this.renderList(); this.changed(); }).open();
      const remove = row.createEl('button', { cls: 'qrs-subscription-icon', attr: { 'data-qrs-label': `取消订阅 ${feed.name}` } });
      setIcon(remove, 'trash-2'); remove.createSpan({ cls: 'qrs-visually-hidden', text: `取消订阅 ${feed.name}` });
      remove.onclick = () => new RemoveSubscription(this.plugin, feed, () => { this.renderList(); this.changed(); }).open();
    }
  }
}
class EditSubscription extends Modal {
  constructor(private plugin: QiaomuRssPlugin, private feed: Subscription, private changed: () => void) { super(plugin.app); }
  onOpen() {
    this.setTitle('编辑订阅'); this.modalEl.addClass('qrs-subscription-modal'); let name = this.feed.name; let group = this.feed.group;
    new Setting(this.contentEl).setName('名称').addText(text => text.setValue(name).onChange(value => { name = value; }));
    new Setting(this.contentEl).setName('分组').addText(text => text.setValue(group).setPlaceholder('未分组').onChange(value => { group = value; }));
    new Setting(this.contentEl).addButton(button => button.setButtonText('保存').setCta().onClick(async () => {
      try { await this.plugin.subscriptions.edit(this.feed.id, name, group); this.changed(); this.close(); }
      catch (error) { new Notice(error instanceof Error ? error.message : '保存失败。'); }
    }));
  }
}
class RemoveSubscription extends Modal {
  constructor(private plugin: QiaomuRssPlugin, private feed: Subscription, private changed: () => void) { super(plugin.app); }
  onOpen() {
    this.setTitle(`取消订阅 ${this.feed.name}`);
    this.contentEl.createEl('p', { text: '移除这个源及其文章列表，已收藏的文章和已保存的笔记会保留。' });
    new Setting(this.contentEl)
      .addButton(button => button.setButtonText('保留订阅').onClick(() => this.close()))
      .addButton(button => button.setButtonText('取消订阅').setDestructive().onClick(async () => {
        await this.plugin.subscriptions.remove(this.feed.id); this.changed(); this.close();
      }));
  }
}
class OpmlImport extends Modal {
  private feeds: FeedInput[] = [];
  constructor(private plugin: QiaomuRssPlugin, private changed: () => void) { super(plugin.app); }
  onOpen() {
    this.setTitle('导入 OPML'); this.modalEl.addClass('qrs-subscription-modal');
    const fieldId = crypto.randomUUID();
    this.contentEl.createEl('label', { cls: 'qrs-visually-hidden', text: '选择 OPML 文件', attr: { for: `qrs-opml-file-${fieldId}` } });
    const input = this.contentEl.createEl('input', { type: 'file', attr: { id: `qrs-opml-file-${fieldId}`, accept: '.opml,.xml,text/xml,application/xml' } });
    this.contentEl.createEl('label', { cls: 'qrs-visually-hidden', text: 'OPML 内容', attr: { for: `qrs-opml-text-${fieldId}` } });
    const area = this.contentEl.createEl('textarea', { cls: 'qrs-opml-text', placeholder: '也可以粘贴 OPML 内容…', attr: { id: `qrs-opml-text-${fieldId}` } });
    const preview = this.contentEl.createDiv({ cls: 'qrs-opml-preview', attr: { role: 'status' } });
    const importButton = this.contentEl.createEl('button', { text: '导入订阅', cls: 'mod-cta' }); importButton.disabled = true;
    const validate = () => {
      this.feeds = []; importButton.disabled = true; preview.empty();
      try {
        const parsed = parseOpml(area.value, this.contentEl.ownerDocument);
        const existing = new Set(this.plugin.state.subscriptions.map(feed => feed.url));
        this.feeds = parsed.feeds.filter(feed => !existing.has(feed.url));
        preview.createEl('p', { text: `新增 ${this.feeds.length} 个订阅，跳过 ${parsed.skipped + parsed.feeds.length - this.feeds.length} 个重复或无效地址。` });
        if (this.feeds.length + existing.size > MAX_SUBSCRIPTIONS) throw new Error(`最多保留 ${MAX_SUBSCRIPTIONS} 个订阅，请减少导入数量。`);
        for (const feed of this.feeds.slice(0, 10)) preview.createDiv({ text: `${feed.group ? feed.group + ' / ' : ''}${feed.name}` });
        if (this.feeds.length > 10) preview.createDiv({ text: `另有 ${this.feeds.length - 10} 个订阅` });
        importButton.disabled = !this.feeds.length;
      } catch (error) { preview.setText(error instanceof Error ? error.message : '文件无法读取。'); }
    };
    area.oninput = validate;
    input.onchange = () => {
      this.feeds = []; importButton.disabled = true;
      const file = input.files?.[0]; if (!file) return;
      if (file.size > 5 * 1024 * 1024) { preview.setText('OPML 文件超过 5 MB。'); return; }
      void file.text().then(value => { area.value = value; validate(); }).catch(() => { preview.setText('文件无法读取。'); });
    };
    this.contentEl.createEl('p', { cls: 'qrs-subscription-help', text: '导入后在“我的订阅”点击刷新获取文章。导入不会覆盖现有订阅的名称和分组。' });
    importButton.onclick = () => {
      importButton.disabled = true;
      void this.plugin.subscriptions.import(this.feeds).then(count => {
        new Notice(`已导入 ${count} 个订阅。`); this.changed(); this.close();
      }).catch((error: unknown) => { preview.setText(error instanceof Error ? error.message : '导入失败。'); importButton.disabled = false; });
    };
  }
}

export class WeChatQrAuthModal extends Modal {
  private wereadTimer?: number;
  private mpTimer?: number;
  private isClosed = false;

  constructor(private plugin: QiaomuRssPlugin, private client: WeMpClient, private onSuccess: () => void) {
    super(plugin.app);
  }

  private clearTimers() {
    if (this.wereadTimer) {
      window.clearInterval(this.wereadTimer);
      this.wereadTimer = undefined;
    }
    if (this.mpTimer) {
      window.clearInterval(this.mpTimer);
      this.mpTimer = undefined;
    }
  }

  async onOpen() {
    this.isClosed = false;
    this.clearTimers();

    this.setTitle('微信抓取授权中心 (双通道)');
    this.modalEl.style.width = '780px';
    this.modalEl.style.maxWidth = '94vw';

    const content = this.contentEl;
    content.empty();
    content.addClass('qrs-subscription-modal');

    content.createEl('p', {
      text: '云端服务支持双通道互备：微信读书通道（日常免密抓取正文，任何微信号均可扫码）与微信公众平台通道（官方已发表接口，需管理员微信号扫码）。两者并列展示，可按需分别扫码授权。',
      attr: { style: 'text-align: center; color: var(--text-muted); margin-bottom: 16px; font-size: 0.88em; line-height: 1.5;' },
    });

    const grid = content.createDiv({
      attr: {
        style: 'display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 16px; margin-bottom: 16px;',
      },
    });

    const leftCol = grid.createDiv({
      attr: {
        style: 'border: 1px solid var(--background-modifier-border); border-radius: 8px; padding: 16px; background: var(--background-secondary); display: flex; flex-direction: column; align-items: center;',
      },
    });

    const rightCol = grid.createDiv({
      attr: {
        style: 'border: 1px solid var(--background-modifier-border); border-radius: 8px; padding: 16px; background: var(--background-secondary); display: flex; flex-direction: column; align-items: center;',
      },
    });

    void this.initWereadColumn(leftCol);
    void this.initMpColumn(rightCol);

    const bottomBar = content.createDiv({
      attr: {
        style: 'display: flex; justify-content: space-between; align-items: center; margin-top: 12px; border-top: 1px solid var(--background-modifier-border); padding-top: 12px;',
      },
    });
    const webBtn = bottomBar.createEl('button', { text: '打开云端完整后台' });
    webBtn.onclick = () => window.open(this.client.baseUrl, '_blank');

    const closeBtn = bottomBar.createEl('button', { text: '完成并关闭', cls: 'mod-cta' });
    closeBtn.onclick = () => this.close();
  }

  private async initWereadColumn(col: HTMLElement) {
    if (this.isClosed) return;
    col.empty();

    const header = col.createDiv({ attr: { style: 'text-align: center; margin-bottom: 12px; width: 100%;' } });
    header.createEl('div', { text: '📚 微信读书通道 (日常抓取)', attr: { style: 'font-weight: 600; font-size: 1.05em;' } });
    header.createEl('div', { text: '个人微信扫码 · 免密抓取已关注公众号最新全文', attr: { style: 'font-size: 0.8em; color: var(--text-muted); margin-top: 2px;' } });

    const bodyEl = col.createDiv({ attr: { style: 'display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 250px; width: 100%;' } });
    bodyEl.createSpan({ text: '⏳ 正在检测状态…', attr: { style: 'color: var(--text-muted); font-size: 0.88em;' } });

    const wereadStatus = await this.client.checkWereadStatus();
    if (this.isClosed) return;

    if (wereadStatus.configured) {
      const testRes = await this.client.testWereadAuth();
      if (this.isClosed) return;

      if (testRes.ok) {
        bodyEl.empty();
        bodyEl.createDiv({ text: '✅', attr: { style: 'font-size: 38px; margin-bottom: 6px;' } });
        bodyEl.createDiv({ text: '微信读书授权有效', attr: { style: 'font-weight: 600; font-size: 1.02em; color: var(--text-success, #2e7d32);' } });
        if (wereadStatus.vid) {
          bodyEl.createDiv({ text: `绑定 VID: ${wereadStatus.vid}`, attr: { style: 'font-size: 0.82em; color: var(--text-muted); margin-top: 4px;' } });
        }
        bodyEl.createDiv({ text: '最新公众号文章正文抓取正常可用', attr: { style: 'font-size: 0.82em; color: var(--text-muted); margin-top: 4px;' } });

        const reBtn = bodyEl.createEl('button', { text: '重新扫码绑定', attr: { style: 'margin-top: 16px;' } });
        reBtn.onclick = () => void this.loadWereadQrFlow(col, bodyEl);
        return;
      }
    }

    await this.loadWereadQrFlow(col, bodyEl);
  }

  private async loadWereadQrFlow(col: HTMLElement, bodyEl: HTMLElement) {
    if (this.isClosed) return;
    bodyEl.empty();
    bodyEl.createSpan({ text: '⏳ 正在生成微信读书二维码…', attr: { style: 'color: var(--text-muted); font-size: 0.88em;' } });

    const qrRes = await this.client.getWereadQrCode();
    if (this.isClosed) return;

    if (!qrRes.ok || !qrRes.qrImageUrl) {
      bodyEl.empty();
      bodyEl.createEl('div', { text: `生成失败: ${qrRes.message}`, attr: { style: 'color: var(--text-error); font-size: 0.85em; text-align: center;' } });
      const retryBtn = bodyEl.createEl('button', { text: '重试', attr: { style: 'margin-top: 10px;' } });
      retryBtn.onclick = () => void this.loadWereadQrFlow(col, bodyEl);
      return;
    }

    bodyEl.empty();
    bodyEl.createEl('img', {
      attr: {
        src: qrRes.qrImageUrl,
        alt: '微信读书二维码',
        style: 'width: 180px; height: 180px; border-radius: 6px; border: 1px solid var(--background-modifier-border); background: #fff; object-fit: contain;',
      },
    });
    bodyEl.createEl('div', { text: '请使用个人微信扫一扫确认', attr: { style: 'font-size: 0.82em; color: var(--text-muted); margin-top: 8px;' } });

    const refreshBtn = bodyEl.createEl('button', { text: '刷新二维码', attr: { style: 'margin-top: 10px; font-size: 0.85em;' } });
    refreshBtn.onclick = () => void this.loadWereadQrFlow(col, bodyEl);

    if (this.wereadTimer) {
      window.clearInterval(this.wereadTimer);
      this.wereadTimer = undefined;
    }
    this.wereadTimer = window.setInterval(() => {
      if (this.isClosed) {
        if (this.wereadTimer) window.clearInterval(this.wereadTimer);
        return;
      }
      void (async () => {
        if (this.isClosed) return;
        const status = await this.client.checkWereadQrStatus();
        if (status.loginStatus && !this.isClosed) {
          if (this.wereadTimer) {
            window.clearInterval(this.wereadTimer);
            this.wereadTimer = undefined;
          }
          await this.client.completeWereadQrLogin();
          new Notice('🎉 微信读书扫码授权成功！');
          this.initWereadColumn(col);
          this.onSuccess();
        }
      })();
    }, 2000);
  }

  private async initMpColumn(col: HTMLElement) {
    if (this.isClosed) return;
    col.empty();

    const header = col.createDiv({ attr: { style: 'text-align: center; margin-bottom: 12px; width: 100%;' } });
    header.createEl('div', { text: '📢 微信公众平台通道 (官方后台)', attr: { style: 'font-weight: 600; font-size: 1.05em;' } });
    header.createEl('div', { text: '管理员微信扫码 · 官方已发表文章接口', attr: { style: 'font-size: 0.8em; color: var(--text-muted); margin-top: 2px;' } });

    const bodyEl = col.createDiv({ attr: { style: 'display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 250px; width: 100%;' } });
    bodyEl.createSpan({ text: '⏳ 正在检测状态…', attr: { style: 'color: var(--text-muted); font-size: 0.88em;' } });

    const mpStatus = await this.client.checkQrStatus();
    if (this.isClosed) return;

    if (mpStatus.loginStatus) {
      bodyEl.empty();
      bodyEl.createDiv({ text: '✅', attr: { style: 'font-size: 38px; margin-bottom: 6px;' } });
      bodyEl.createDiv({ text: '公众平台后台已登录', attr: { style: 'font-weight: 600; font-size: 1.02em; color: var(--text-success, #2e7d32);' } });
      bodyEl.createDiv({ text: '官方群发列表拉取接口处于连接状态', attr: { style: 'font-size: 0.82em; color: var(--text-muted); margin-top: 4px;' } });

      const reBtn = bodyEl.createEl('button', { text: '重新扫码登录', attr: { style: 'margin-top: 16px;' } });
      reBtn.onclick = () => void this.loadMpQrFlow(col, bodyEl);
      return;
    }

    await this.loadMpQrFlow(col, bodyEl);
  }

  private async loadMpQrFlow(col: HTMLElement, bodyEl: HTMLElement) {
    if (this.isClosed) return;
    bodyEl.empty();
    const progressEl = bodyEl.createSpan({ text: '⏳ 正在请求公众平台登录二维码…', attr: { style: 'color: var(--text-muted); font-size: 0.88em; text-align: center;' } });

    const qrRes = await this.client.getQrCode(msg => {
      if (!this.isClosed) progressEl.setText(msg);
    });
    if (this.isClosed) return;

    if (!qrRes.ok || !qrRes.qrImageUrl) {
      bodyEl.empty();
      bodyEl.createEl('div', { text: `生成失败: ${qrRes.message}`, attr: { style: 'color: var(--text-error); font-size: 0.85em; text-align: center;' } });
      const retryBtn = bodyEl.createEl('button', { text: '重试', attr: { style: 'margin-top: 10px;' } });
      retryBtn.onclick = () => void this.loadMpQrFlow(col, bodyEl);
      return;
    }

    bodyEl.empty();
    bodyEl.createEl('img', {
      attr: {
        src: qrRes.qrImageUrl,
        alt: '公众平台登录二维码',
        style: 'width: 180px; height: 180px; border-radius: 6px; border: 1px solid var(--background-modifier-border); background: #fff; object-fit: contain;',
      },
    });
    bodyEl.createEl('div', { text: '请使用公众号管理员/运营者微信扫码', attr: { style: 'font-size: 0.82em; color: var(--text-muted); margin-top: 8px;' } });

    const refreshBtn = bodyEl.createEl('button', { text: '刷新二维码', attr: { style: 'margin-top: 10px; font-size: 0.85em;' } });
    refreshBtn.onclick = () => void this.loadMpQrFlow(col, bodyEl);

    if (this.mpTimer) {
      window.clearInterval(this.mpTimer);
      this.mpTimer = undefined;
    }
    this.mpTimer = window.setInterval(() => {
      if (this.isClosed) {
        if (this.mpTimer) window.clearInterval(this.mpTimer);
        return;
      }
      void (async () => {
        if (this.isClosed) return;
        const status = await this.client.checkQrStatus();
        if (status.loginStatus && !this.isClosed) {
          if (this.mpTimer) {
            window.clearInterval(this.mpTimer);
            this.mpTimer = undefined;
          }
          await this.client.completeQrLogin();
          new Notice('🎉 微信公众号平台扫码授权成功！');
          this.initMpColumn(col);
          this.onSuccess();
        }
      })();
    }, 2000);
  }

  onClose() {
    this.isClosed = true;
    this.clearTimers();
    this.contentEl.empty();
  }
}

export class ImportWechatArticleModal extends Modal {
  constructor(private plugin: QiaomuRssPlugin, private client: WeMpClient, private onSuccess: () => void) {
    super(plugin.app);
  }

  onOpen() {
    this.setTitle('导入单篇微信文章');
    const content = this.contentEl;
    content.empty();
    content.addClass('qrs-subscription-modal');

    content.createEl('p', {
      text: '粘贴任意微信公众号文章链接（https://mp.weixin.qq.com/s/...），云端将实时抓取全文并加入「精选文章」源：',
      attr: { style: 'color: var(--text-muted); margin-bottom: 12px;' },
    });

    const form = content.createEl('form', { cls: 'qrs-subscription-add' });
    const input = form.createEl('input', {
      type: 'url',
      placeholder: 'https://mp.weixin.qq.com/s/...',
      attr: { style: 'flex: 1;', required: '' },
    });
    const submitBtn = form.createEl('button', { text: '抓取并订阅', type: 'submit', cls: 'mod-cta' });
    const statusMsg = content.createDiv({ cls: 'qrs-subscription-message', attr: { role: 'status' } });

    form.onsubmit = async (e) => {
      e.preventDefault();
      const url = input.value.trim();
      if (!url.includes('mp.weixin.qq.com/s/')) {
        statusMsg.setText('请输入有效的微信公众号文章链接 (以 https://mp.weixin.qq.com/s/ 开头)');
        return;
      }

      submitBtn.disabled = true;
      submitBtn.setText('正在抓取…');
      statusMsg.setText('云端正在使用无头浏览器提取文章并生成订阅源，约需 5~10 秒…');

      try {
        const res = await this.client.importArticle(url);
        if (res.ok && res.feedUrl) {
          const existing = this.plugin.state.subscriptions.find(s => s.url === res.feedUrl);
          let targetFeedId = '';
          if (existing) {
            await this.plugin.subscriptions.refresh([existing.id], this.contentEl.ownerDocument, true);
            targetFeedId = existing.id;
          } else {
            const newFeed = await this.plugin.subscriptions.add(res.feedUrl, '微信公众号', this.contentEl.ownerDocument);
            targetFeedId = newFeed.id;
          }

          const featuredSub = this.plugin.state.subscriptions.find(s => s.id === targetFeedId);
          const addedEntry = featuredSub?.entries.find(e => e.link?.includes(url.trim()) || url.trim().includes(e.link || ''));
          let matchedSubName = '';

          if (addedEntry) {
            const targetAuthor = addedEntry.author?.trim();
            if (targetAuthor && targetAuthor !== '精选文章') {
              const matchedSub = this.plugin.state.subscriptions.find(s => s.id !== targetFeedId && (s.name === targetAuthor || s.name.includes(targetAuthor) || targetAuthor.includes(s.name)));
              if (matchedSub) {
                matchedSubName = matchedSub.name;
                const alreadyHas = matchedSub.entries.some(e => e.link === addedEntry.link || canonicalEntryKey(e) === canonicalEntryKey(addedEntry));
                if (!alreadyHas) {
                  matchedSub.entries.unshift({
                    ...addedEntry,
                    id: `local-${matchedSub.id}-${addedEntry.id}`,
                    sourceId: matchedSub.id,
                    sourceName: matchedSub.name,
                    author: matchedSub.name,
                  });
                  matchedSub.entries.sort((a, b) => (b.publishedTs || 0) - (a.publishedTs || 0));
                }
                const subChannelKey = JSON.stringify([this.plugin.state.settings.baseUrl, matchedSub.id]);
                delete this.plugin.state.channelStates[subChannelKey];
                targetFeedId = matchedSub.id;
              }
            }
          }

          if (targetFeedId) {
            const channelKey = JSON.stringify([this.plugin.state.settings.baseUrl, targetFeedId]);
            delete this.plugin.state.channelStates[channelKey];
            const groupKey = JSON.stringify([this.plugin.state.settings.baseUrl, '@group:微信公众号']);
            delete this.plugin.state.channelStates[groupKey];
            const localKey = JSON.stringify([this.plugin.state.settings.baseUrl, '@local']);
            delete this.plugin.state.channelStates[localKey];

            this.plugin.state.settings.lastSource = targetFeedId;
            await this.plugin.persist();
            this.plugin.resetViews();
          }
          const locationTip = matchedSubName ? `已自动归类至「${matchedSubName}」及「精选文章」` : '已归入「精选文章」';
          new Notice(res.title ? `🎉「${res.title}」抓取成功！${locationTip}` : `文章已成功抓取！${locationTip}`, 7000);
          this.close();
          this.onSuccess();
        } else {
          statusMsg.setText(res.message);
          submitBtn.disabled = false;
          submitBtn.setText('抓取并订阅');
        }
      } catch (err) {
        statusMsg.setText(`抓取失败: ${err instanceof Error ? err.message : String(err)}`);
        submitBtn.disabled = false;
        submitBtn.setText('抓取并订阅');
      }
    };
  }
}
