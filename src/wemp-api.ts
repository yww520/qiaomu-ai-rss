import { requestUrl } from 'obsidian';

export interface WeMpAccount {
  id: string;
  name: string;
  avatar?: string;
  description?: string;
  fakeid?: string;
  feedUrl: string;
  subscribed?: boolean;
}

interface ApiResponse<T> {
  code?: number;
  data?: T;
  message?: string;
}

interface MpListResult {
  list?: Array<{
    id: string;
    mp_name?: string;
    mp_cover?: string;
    mp_intro?: string;
  }>;
}

interface SearchResult {
  list?: Array<{
    fakeid?: string;
    id?: string;
    nickname?: string;
    name?: string;
    round_head_img?: string;
    avatar?: string;
    signature?: string;
    description?: string;
  }>;
}

export class WeMpClient {
  private cachedToken: string = '';

  constructor(private getServerUrl: () => string, private getToken: () => string) {}

  public get baseUrl(): string {
    let url = this.getServerUrl().trim();
    if (url.endsWith('/')) url = url.slice(0, -1);
    return url;
  }

  private async ensureToken(): Promise<string> {
    const configured = this.getToken().trim();
    if (configured) return configured;
    if (this.cachedToken) return this.cachedToken;

    // Try login with default admin credentials
    try {
      const loginUrl = `${this.baseUrl}/api/v1/wx/auth/login`;
      const res = await requestUrl({
        url: loginUrl,
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'username=admin&password=admin@123',
        throw: false,
      });
      if (res.status === 200) {
        const json = res.json as ApiResponse<{ access_token?: string }>;
        if (json?.data?.access_token) {
          this.cachedToken = json.data.access_token;
          return this.cachedToken;
        }
      }
    } catch (e) {
      console.warn('[WeMpClient] auto login failed:', e);
    }
    return '';
  }

  private async getHeaders(): Promise<Record<string, string>> {
    const token = await this.ensureToken();
    const headers: Record<string, string> = {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    return headers;
  }

  async checkHealth(): Promise<{ ok: boolean; message: string; requiresAuth?: boolean }> {
    try {
      const rootRes = await requestUrl({ url: `${this.baseUrl}/`, method: 'GET', throw: false });
      if (rootRes.status === 200) {
        const headers = await this.getHeaders();
        const mpsRes = await requestUrl({ url: `${this.baseUrl}/api/v1/wx/mps?limit=1`, method: 'GET', headers, throw: false });
        if (mpsRes.status === 401 || mpsRes.status === 403) {
          return { ok: true, message: '服务在线（需在设置中配置 Access Token）', requiresAuth: true };
        }
        return { ok: true, message: '服务在线且连接正常' };
      }
      return { ok: false, message: `服务响应异常 (HTTP ${rootRes.status})` };
    } catch (e) {
      return { ok: false, message: `无法连接服务器: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  async getQrCode(): Promise<{ ok: boolean; qrImageUrl: string; message: string }> {
    try {
      const headers = await this.getHeaders();
      const url = `${this.baseUrl}/api/v1/wx/auth/qr/code`;
      const res = await requestUrl({ url, method: 'GET', headers, throw: false });
      if (res.status === 200) {
        const json = res.json as ApiResponse<{ code?: string }>;
        const codePath = json?.data?.code || '';
        if (codePath) {
          const qrImageUrl = codePath.startsWith('http') ? codePath : `${this.baseUrl}${codePath}`;
          return { ok: true, qrImageUrl, message: '获取成功' };
        }
      }
      return { ok: false, qrImageUrl: '', message: `获取二维码失败 (HTTP ${res.status})` };
    } catch (e) {
      return { ok: false, qrImageUrl: '', message: String(e) };
    }
  }

  async checkQrStatus(): Promise<{ loginStatus: boolean; qrCode: boolean }> {
    try {
      const headers = await this.getHeaders();
      const url = `${this.baseUrl}/api/v1/wx/auth/qr/status`;
      const res = await requestUrl({ url, method: 'GET', headers, throw: false });
      if (res.status === 200) {
        const json = res.json as ApiResponse<{ login_status?: boolean; qr_code?: boolean }>;
        return {
          loginStatus: Boolean(json?.data?.login_status),
          qrCode: Boolean(json?.data?.qr_code),
        };
      }
      return { loginStatus: false, qrCode: false };
    } catch {
      return { loginStatus: false, qrCode: false };
    }
  }

  async listSubscribedMps(): Promise<WeMpAccount[]> {
    try {
      const headers = await this.getHeaders();
      const url = `${this.baseUrl}/api/v1/wx/mps?limit=100`;
      const res = await requestUrl({ url, method: 'GET', headers, throw: false });
      if (res.status === 200) {
        const json = res.json as ApiResponse<MpListResult> | undefined;
        const list = json?.data?.list ?? [];
        return list.map(item => ({
          id: String(item.id),
          name: item.mp_name ?? '未命名公众号',
          avatar: item.mp_cover?.startsWith('http') ? item.mp_cover : `${this.baseUrl}${item.mp_cover ?? ''}`,
          description: item.mp_intro ?? '',
          feedUrl: `${this.baseUrl}/feed/${item.id}`,
          subscribed: true,
        }));
      }
      return [];
    } catch (e) {
      console.error('[WeMpClient] listSubscribedMps error:', e);
      return [];
    }
  }

  async searchAccounts(keyword: string): Promise<WeMpAccount[]> {
    if (!keyword.trim()) return [];
    try {
      const headers = await this.getHeaders();
      const query = encodeURIComponent(keyword.trim());
      const url = `${this.baseUrl}/api/v1/wx/mps/search/${query}`;
      const res = await requestUrl({ url, method: 'GET', headers, throw: false });
      if (res.status === 200) {
        const json = res.json as ApiResponse<SearchResult> | undefined;
        const list = json?.data?.list ?? [];
        return list.map(item => ({
          id: String(item.fakeid ?? item.id ?? ''),
          name: item.nickname ?? item.name ?? keyword,
          avatar: item.round_head_img ?? item.avatar ?? '',
          description: item.signature ?? item.description ?? '',
          fakeid: item.fakeid ?? '',
          feedUrl: `${this.baseUrl}/feed/${item.id ?? item.fakeid ?? ''}`,
          subscribed: false,
        }));
      }
      return [];
    } catch (e) {
      console.error('[WeMpClient] searchAccounts error:', e);
      return [];
    }
  }

  async subscribe(account: WeMpAccount): Promise<{ ok: boolean; feedUrl: string; message: string }> {
    try {
      const headers = await this.getHeaders();
      const url = `${this.baseUrl}/api/v1/wx/mps`;
      const res = await requestUrl({
        url,
        method: 'POST',
        headers,
        body: JSON.stringify({
          mp_name: account.name,
          mp_id: account.fakeid ?? account.id,
          avatar: account.avatar ?? '',
          mp_intro: account.description ?? '',
        }),
        throw: false,
      });

      if (res.status >= 200 && res.status < 300) {
        const json = res.json as ApiResponse<{ id?: string }> | undefined;
        const feedId = json?.data?.id ?? account.id;
        return { ok: true, feedUrl: `${this.baseUrl}/feed/${feedId}`, message: '订阅成功' };
      }
      return { ok: true, feedUrl: `${this.baseUrl}/feed/${account.id}`, message: '已提交订阅' };
    } catch {
      return { ok: true, feedUrl: `${this.baseUrl}/feed/${account.id}`, message: '添加订阅源' };
    }
  }
}
