import { describe, expect, it } from 'vitest';
import { generateArticleSummary, DEFAULT_AI_PROMPT } from '../src/ai-summary';
import { requestUrl } from './obsidian-mock';

describe('AI Summary', () => {
  it('throws if apiKey is not provided', async () => {
    await expect(
      generateArticleSummary('Title', 'Content', { apiUrl: 'https://api.deepseek.com/v1', apiKey: '', model: 'deepseek-chat' })
    ).rejects.toThrow('请先在设置中配置 AI API Key');
  });

  it('formats endpoint URL and sends completion payload', async () => {
    let capturedOpts: any = null;
    requestUrl.mockImplementationOnce(async (opts: any) => {
      capturedOpts = opts;
      return {
        status: 200,
        json: {
          choices: [
            {
              message: {
                content: '### 💡 核心洞察\n这是一篇关于 AI 的深度好文。',
              },
            },
          ],
        },
      };
    });

    const summary = await generateArticleSummary('AI 浪潮', '这是一篇关于大模型的内容。', {
      apiUrl: 'https://api.deepseek.com/v1/',
      apiKey: 'sk-test-key',
      model: 'deepseek-chat',
    });

    expect(summary).toBe('### 💡 核心洞察\n这是一篇关于 AI 的深度好文。');
    expect(capturedOpts.url).toBe('https://api.deepseek.com/v1/chat/completions');
    expect(capturedOpts.headers['Authorization']).toBe('Bearer sk-test-key');

    const body = JSON.parse(capturedOpts.body);
    expect(body.model).toBe('deepseek-chat');
    expect(body.messages[0].content).toBe(DEFAULT_AI_PROMPT);
    expect(body.messages[1].content).toContain('【文章标题】：AI 浪潮');
    expect(body.messages[1].content).toContain('【文章正文】：\n这是一篇关于大模型的内容。');
  });

  it('uses custom prompt when provided', async () => {
    let capturedOpts: any = null;
    requestUrl.mockImplementationOnce(async (opts: any) => {
      capturedOpts = opts;
      return {
        status: 200,
        json: {
          choices: [
            {
              message: {
                content: '简短总结',
              },
            },
          ],
        },
      };
    });

    const summary = await generateArticleSummary('Title', 'Content', {
      apiUrl: 'https://api.deepseek.com/v1',
      apiKey: 'sk-test-key',
      model: 'deepseek-chat',
      prompt: '请用一句话总结：',
    });

    expect(summary).toBe('简短总结');
    const body = JSON.parse(capturedOpts.body);
    expect(body.messages[0].content).toBe('请用一句话总结：');
  });

  it('handles API error responses gracefully', async () => {
    requestUrl.mockImplementationOnce(async () => {
      return {
        status: 401,
        json: {
          error: {
            message: 'Invalid API key',
          },
        },
      };
    });

    await expect(
      generateArticleSummary('Title', 'Content', {
        apiUrl: 'https://api.deepseek.com/v1',
        apiKey: 'sk-invalid',
        model: 'deepseek-chat',
      })
    ).rejects.toThrow('AI 请求失败 (Invalid API key)');
  });
});
