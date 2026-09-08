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
});
