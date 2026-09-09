import { requestUrl } from 'obsidian';

export interface AiSummaryConfig {
  apiUrl: string;
  apiKey: string;
  model: string;
  prompt?: string;
}

export const DEFAULT_AI_PROMPT = `你是一位高水准的深度阅读与投资思考助手。请根据提供的文章标题和内容，提炼出清晰、精炼、富有洞察力的结构化总结：

要求格式如下：
### 💡 核心洞察
用 1-2 句话概括文章的最核心论点或底层逻辑。

### 📌 关键要点
- **要点 1**：核心论据或事实细节
- **要点 2**：关键数据、案例或逻辑推导
- **要点 3**：延伸思考或结论

### 🎯 思考与启发
对投资决策、商业认知或个人行动带来的 1 条关键启示。

请直接输出 Markdown 内容，语言简洁精练，不要有多余的客套寒暄。`;

export async function generateArticleSummary(
  title: string,
  content: string,
  config: AiSummaryConfig,
  onStatus?: (msg: string) => void
): Promise<string> {
  const apiKey = config.apiKey?.trim();
  if (!apiKey) {
    throw new Error('请先在设置中配置 AI API Key。');
  }

  let apiUrl = (config.apiUrl?.trim() || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
  if (!apiUrl.endsWith('/chat/completions')) {
    apiUrl = `${apiUrl}/chat/completions`;
  }

  const model = config.model?.trim() || 'deepseek-chat';
  const systemPrompt = config.prompt?.trim() || DEFAULT_AI_PROMPT;

  const maxLen = 15000;
  const truncatedContent = content.length > maxLen ? `${content.slice(0, maxLen)}\n\n[...正文过长已截断...]` : content;

  onStatus?.('正在调用 AI 生成深度总结…');

  const payload = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: `【文章标题】：${title}\n\n【文章正文】：\n${truncatedContent}`,
      },
    ],
    temperature: 0.3,
  };

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };

  const response = await requestUrl({
    url: apiUrl,
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    throw: false,
  });

  if (response.status !== 200) {
    let errMsg = `HTTP ${response.status}`;
    try {
      const errJson = response.json as { error?: { message?: string }; message?: string };
      errMsg = errJson?.error?.message || errJson?.message || errMsg;
    } catch {
      // ignore
    }
    throw new Error(`AI 请求失败 (${errMsg})`);
  }

  const data = response.json as {
    choices?: Array<{ message?: { content?: string } }>;
  };

  const result = data?.choices?.[0]?.message?.content?.trim();
  if (!result) {
    throw new Error('AI 未能返回有效的总结内容。');
  }

  return result;
}
