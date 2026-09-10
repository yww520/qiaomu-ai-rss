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

export const DEFAULT_FOLLOW_UP_SYSTEM_PROMPT = `你是一位专业、敏锐的深度阅读与思考研究助手。
用户正在深入研读文章，并已经阅读了核心总结。
请结合文章标题、正文细节、核心总结以及对话上下文，准确、深入、逻辑严谨地回答用户的追问。

回答原则：
1. 紧扣文章：优先结合文章事实、论据、数据与案例进行回答，有理有据；
2. 边界清晰：如果文章中未明确提及用户追问的事项，请明确说明文中未载，并可基于通用专业认知做合理推演；
3. 输出美观：采用清晰排版的 Markdown（善用列表、加粗、引用），语言精炼深刻，不讲套话。`;

export async function askArticleFollowUp(
  title: string,
  content: string,
  summary: string,
  history: Array<{ role: 'user' | 'assistant'; content: string }>,
  question: string,
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
  const systemPrompt = DEFAULT_FOLLOW_UP_SYSTEM_PROMPT;

  const maxLen = 15000;
  const truncatedContent = content.length > maxLen ? `${content.slice(0, maxLen)}\n\n[...正文过长已截断...]` : content;

  onStatus?.('正在思考并组织追问回答…');

  const messages: Array<{ role: string; content: string }> = [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content: `【研读文章标题】：${title}\n\n【文章核心总结】：\n${summary || '（暂无总结）'}\n\n【文章正文内容】：\n${truncatedContent}`,
    },
    {
      role: 'assistant',
      content: `我已经仔细研读了文章《${title}》及其核心总结与正文细节。请随时提出任何追问，我将为您深入解析。`,
    },
  ];

  for (const msg of history) {
    messages.push({
      role: msg.role === 'user' ? 'user' : 'assistant',
      content: msg.content,
    });
  }

  messages.push({
    role: 'user',
    content: question.trim(),
  });

  const payload = {
    model,
    messages,
    temperature: 0.5,
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
    throw new Error(`AI 追问失败 (${errMsg})`);
  }

  const data = response.json as {
    choices?: Array<{ message?: { content?: string } }>;
  };

  const result = data?.choices?.[0]?.message?.content?.trim();
  if (!result) {
    throw new Error('AI 未能返回有效的解答内容。');
  }

  return result;
}
