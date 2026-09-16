import { requestUrl } from 'obsidian';

/**
 * Extract rich content directly from a WeChat article URL.
 * Supports:
 * 1. Standard WeChat rich-text articles (id="js_content")
 * 2. WeChat Picture/Text notes (小绿书 / page_type: 2, from text_page_info and picture_page_info_list)
 * 3. WeChat audio/podcast episodes (voice_in_appmsg)
 */
export function cleanWeChatUrl(url: string): string {
  if (!url || !url.includes('mp.weixin.qq.com/s/')) return url;
  return url.replace(/mp\.weixin\.qq\.com\/s\/([^?#]+)/, (_, token) => {
    return 'mp.weixin.qq.com/s/' + token.replace(/~/g, '_');
  });
}

export async function fetchWeChatArticleDirect(url: string): Promise<string | null> {
  if (!url || !url.includes('mp.weixin.qq.com/s/')) return null;
  const cleanUrl = cleanWeChatUrl(url);

  try {
    const res = await requestUrl({
      url: cleanUrl,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
      throw: false,
    });

    if (res.status !== 200 || !res.text) return null;
    return parseWeChatHtml(res.text);
  } catch (e) {
    console.warn('[WeChatFetcher] Direct fetch error:', e);
    return null;
  }
}

export function parseWeChatHtml(html: string): string | null {
  if (!html) return null;

  // 1. Regular article with js_content
  const jsContentMatch = html.match(/id=["']js_content["'][^>]*>([\s\S]*?)<\/div>\s*<div[^>]*id=["']js_like_educate["']/i)
    || html.match(/id=["']js_content["'][^>]*>([\s\S]*?)<\/div>\s*<ul[^>]*class=["']reward_area["']/i)
    || html.match(/id=["']js_content["'][^>]*>([\s\S]*?)<\/div>/i);

  if (jsContentMatch && jsContentMatch[1].trim().length > 20) {
    return jsContentMatch[1].trim();
  }

  // 2. Picture page / Note (小绿书) with text_page_info
  const textMatch = html.match(/text_page_info:\s*\{[\s\S]*?content:\s*['"]([\s\S]*?)['"]\s*,/);
  if (textMatch) {
    const raw = textMatch[1];
    const clean = raw
      .replace(/\\x0a/g, '\n')
      .replace(/\\x([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '')
      .replace(/\\+/g, '')
      .trim();

    // Check for pictures in picture_page_info_list
    const listMatch = html.match(/picture_page_info_list:\s*\[([\s\S]*?)\]/);
    let imgHtml = '';
    if (listMatch) {
      const urls = [...listMatch[1].matchAll(/cdn_url:\s*['"]([^'"]+)['"]/g)].map(m => m[1]);
      if (urls.length > 0) {
        imgHtml = urls.map(u => `<p><img src="${u}" referrerpolicy="no-referrer"></p>`).join('\n') + '\n';
      }
    }

    const paragraphs = clean
      .split(/\n+/)
      .map(p => p.trim())
      .filter(Boolean)
      .map(p => `<p>${p}</p>`)
      .join('\n');

    if (paragraphs.length > 0 || imgHtml.length > 0) {
      return (imgHtml + paragraphs).trim();
    }
  }

  // 3. Audio / Podcast article
  if (html.includes('voice_in_appmsg')) {
    const audioTitle = (html.match(/class=["']audio_title["'][^>]*>([\s\S]*?)<\/span>/i) || [])[1] || '微信音频节目';
    return `<div class="qrs-audio-notice"><p><strong>🎙️ 微信原生音频/播客节目</strong></p><p>本篇为包含原生音频的播客内容（${audioTitle.trim()}）。请点击下方按钮在浏览器中打开收听完整音频。</p></div>`;
  }

  return null;
}
