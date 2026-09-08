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

