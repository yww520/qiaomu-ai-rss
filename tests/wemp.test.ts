import { describe, expect, it, vi } from 'vitest';
import { WeMpClient } from '../src/wemp-api';

describe('WeMpClient', () => {
  it('formats base URL properly without trailing slash', () => {
    const client = new WeMpClient(() => 'http://43.156.114.156:8001/', () => '');
    expect(client.baseUrl).toBe('http://43.156.114.156:8001');
  });

  it('handles search and account transformation', async () => {
    const client = new WeMpClient(() => 'http://43.156.114.156:8001', () => 'test-token');
    const emptyResult = await client.searchAccounts('');
    expect(emptyResult).toEqual([]);
  });

  it('downloads QR image and returns base64 data URI when qr_code is ready', async () => {
    const { requestUrl } = await import('./obsidian-mock');
    const client = new WeMpClient(() => 'http://43.156.114.156:8001', () => 'test-token');

    // Mock QR code init, status poll, and image fetch
    requestUrl.mockImplementation(async (opts: { url: string }) => {
      if (opts.url.includes('/api/v1/wx/auth/qr/code')) {
        return { status: 200, json: { code: 0, data: { code: '/static/wx_qrcode.png' } } };
      }
      if (opts.url.includes('/api/v1/wx/auth/qr/status')) {
        return { status: 200, json: { code: 0, data: { login_status: false, qr_code: true } } };
      }
      if (opts.url.includes('/static/wx_qrcode.png')) {
        return { status: 200, arrayBuffer: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]).buffer };
      }
      return { status: 404 };
    });

    const res = await client.getQrCode();
    expect(res.ok).toBe(true);
    expect(res.qrImageUrl.startsWith('data:image/png;base64,')).toBe(true);
  });
});

describe('parseWeChatHtml', () => {
  it('extracts regular article content from js_content container', async () => {
    const { parseWeChatHtml } = await import('../src/wechat-fetcher');
    const html = '<div id="js_content"><p>这是微信公众号文章正文第一段，内容详实且丰富。</p><p>这是第二段正文。</p></div><div id="js_like_educate"></div>';
    const parsed = parseWeChatHtml(html);
    expect(parsed).toContain('这是微信公众号文章正文第一段');
    expect(parsed).toContain('这是第二段正文');
  });

  it('extracts picture and text note (小绿书) from text_page_info and picture_page_info_list', async () => {
    const { parseWeChatHtml } = await import('../src/wechat-fetcher');
    const html = `
      var someData = {
        picture_page_info_list: [
          { cdn_url: 'https://mmbiz.qpic.cn/image1.jpg' }
        ],
        text_page_info: {
          content: '投资中不要做的事\\x0a\\x0a1、给亏损分类，找到你不赚钱的习惯\\\\\\n\\\\\\n2、别因为卖掉了赢家，就以为自己锁定了收益',
          content_noencode: '...'
        }
      };
    `;
    const parsed = parseWeChatHtml(html);
    expect(parsed).toContain('<img src="https://mmbiz.qpic.cn/image1.jpg"');
    expect(parsed).toContain('<p>投资中不要做的事</p>');
    expect(parsed).toContain('<p>1、给亏损分类，找到你不赚钱的习惯</p>');
    expect(parsed).toContain('<p>2、别因为卖掉了赢家，就以为自己锁定了收益</p>');
  });

  it('identifies audio podcast episodes', async () => {
    const { parseWeChatHtml } = await import('../src/wechat-fetcher');
    const html = '<div>voice_in_appmsg: [{ voice_id: "123" }]</div>';
    const parsed = parseWeChatHtml(html);
    expect(parsed).toContain('微信原生音频/播客节目');
  });
});

