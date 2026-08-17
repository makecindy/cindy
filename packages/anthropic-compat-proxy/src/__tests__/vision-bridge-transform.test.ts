/**
 * vision-bridge-transform 单元测试。
 *
 * 覆盖层 A transform 的：双格式解析（Anthropic image / Responses input_image）、
 * shouldBridge 短路（未启用 / 非目标模型 → 字节透传）、focus hint 提取、失败降级占位。
 */
import { describe, expect, it, vi } from 'vitest';

import { createVisionBridgeTransform } from '../vision-bridge-transform.js';

const DESCRIBE = vi.fn(async ({ imageUrl, prompt }: { imageUrl: string; prompt: string }) => {
  return `[desc of ${imageUrl.slice(0, 24)} with hint "${prompt.slice(0, 12)}"]`;
});

function makeTransform() {
  return createVisionBridgeTransform({
    shouldBridge: (m) => m === 'deepseek-v4',
    describeImage: DESCRIBE,
  });
}

describe('createVisionBridgeTransform (Anthropic Messages)', () => {
  it('replaces user image blocks with descriptions', async () => {
    const t = makeTransform();
    const out = await t(
      {
        model: 'deepseek-v4',
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'what is this?' }] },
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } },
            ],
          },
        ],
      },
      { reqId: 1, method: 'POST', url: '/v1/messages', headers: {} },
    );
    expect(out).not.toBeNull();
    const messages = (out as { messages: unknown[] }).messages;
    const replaced = (messages[1] as { content: unknown[] }).content[0] as {
      type: string;
      text: string;
    };
    expect(replaced.type).toBe('text');
    expect(replaced.text).toContain('desc of');
    // focus hint 来自最近 user 文本
    expect(DESCRIBE).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'what is this?' }));
  });

  it('replaces tool_result nested images', async () => {
    const t = makeTransform();
    const out = await t(
      {
        model: 'deepseek-v4',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 't1',
                content: [
                  { type: 'text', text: 'ok' },
                  { type: 'image', source: { type: 'url', url: 'https://x/y.png' } },
                ],
              },
            ],
          },
        ],
      },
      { reqId: 1, method: 'POST', url: '/v1/messages', headers: {} },
    );
    const inner = (
      (out as { messages: unknown[] }).messages[0] as {
        content: Array<{ type: string; content: unknown[] }>;
      }
    ).content[0].content;
    const replaced = inner[1] as { type: string; text: string };
    expect(replaced.type).toBe('text');
    expect(replaced.text).toContain('desc of');
  });

  it('omits non-bridgeable image url schemes (private protocols / local paths / obfuscation)', async () => {
    const loggerWarn = vi.fn();
    // 私有协议 / 本地路径 / 换行混淆：不透传给第三方视觉后端，显式降级为「图片不可用」占位。
    // 大写 data: 是合法 data URL，应正常放行走 describeImage（不会被拒绝）。
    const describe = vi.fn(async () => 'data uri described');
    const t = createVisionBridgeTransform({
      shouldBridge: () => true,
      describeImage: describe,
      logger: { warn: loggerWarn },
    });
    for (const url of [
      'cindy-media://blobs/abc',
      'xdt-image://s/x.png',
      'file:///C:/x.png',
      'C:\\\\Users\\\\x.png',
      'http:\n//evil', // 真实换行混淆：控制字符必须拦截
    ]) {
      const out = await t(
        {
          model: 'deepseek-v4',
          messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'url', url } }] }],
        },
        { reqId: 1, method: 'POST', url: '/v1/messages', headers: {} },
      );
      expect(out).not.toBeNull();
      const replaced = (out as { messages: unknown[] }).messages[0] as {
        content: Array<{ type: string; text: string }>;
      };
      expect(replaced.content[0].type).toBe('text');
      expect(replaced.content[0].text).toContain('Image unavailable');
      expect(replaced.content[0].text).not.toContain(url);
    }
    // DATA: 大写走 describeImage，不被拦截。
    const dataOut = await t(
      {
        model: 'deepseek-v4',
        messages: [
          { role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'DATA:image/png;base64,QUJD' } }] },
        ],
      },
      { reqId: 1, method: 'POST', url: '/v1/messages', headers: {} },
    );
    const dataReplaced = (dataOut as { messages: unknown[] }).messages[0] as {
      content: Array<{ type: string; text: string }>;
    };
    expect(dataReplaced.content[0].text).toContain('data uri described');
    expect(loggerWarn).toHaveBeenCalled();
  });

  it('degrades image blocks with no usable source to unavailable placeholder', async () => {
    const loggerWarn = vi.fn();
    const t = createVisionBridgeTransform({
      shouldBridge: () => true,
      describeImage: async () => 'should not be called',
      logger: { warn: loggerWarn },
    });
    // source 类型缺失 / 非法：不再静默透传，显式降级。
    const out = await t(
      {
        model: 'deepseek-v4',
        messages: [
          { role: 'user', content: [{ type: 'image', source: { type: 'weird', url: 'x' } }] },
        ],
      },
      { reqId: 1, method: 'POST', url: '/v1/messages', headers: {} },
    );
    expect(out).not.toBeNull();
    const replaced = (out as { messages: unknown[] }).messages[0] as {
      content: Array<{ type: string; text: string }>;
    };
    expect(replaced.content[0].type).toBe('text');
    expect(replaced.content[0].text).toContain('Image unavailable');
    expect(loggerWarn).toHaveBeenCalled();
  });

  it('returns null (passthrough) when shouldBridge is false', async () => {
    const t = makeTransform();
    const out = await t(
      {
        model: 'claude-sonnet-4-8',
        messages: [
          { role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'https://x/y.png' } }] },
        ],
      },
      { reqId: 1, method: 'POST', url: '/v1/messages', headers: {} },
    );
    expect(out).toBeNull();
  });

  it('returns null when no images present', async () => {
    const t = makeTransform();
    const out = await t(
      { model: 'deepseek-v4', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] },
      { reqId: 1, method: 'POST', url: '/v1/messages', headers: {} },
    );
    expect(out).toBeNull();
  });

  it('falls back to [Image unavailable ...] placeholder on describeImage error', async () => {
    const loggerWarn = vi.fn();
    const t = createVisionBridgeTransform({
      shouldBridge: () => true,
      describeImage: async () => {
        throw new Error('boom');
      },
      logger: { warn: loggerWarn },
    });
    const out = await t(
      {
        model: 'deepseek-v4',
        messages: [
          { role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'https://x/y.png' } }] },
        ],
      },
      { reqId: 1, method: 'POST', url: '/v1/messages', headers: {} },
    );
    // 失败记内部 warn（含 reqId 关联 + 脱敏 error，不进模型输入）。
    expect(loggerWarn).toHaveBeenCalledWith(
      expect.stringContaining('vision bridge transform failed'),
      expect.objectContaining({
        reqId: 1,
        url: '/v1/messages',
        model: 'deepseek-v4',
        error: 'boom',
      }),
    );
    const replaced = (out as { messages: unknown[] }).messages[0] as {
      content: Array<{ type: string; text: string }>;
    };
    expect(replaced.content[0].type).toBe('text');
    expect(replaced.content[0].text).toContain('Image unavailable');
    expect(replaced.content[0].text).toContain('Do not infer visual details');
    // 脱敏：占位不进原始错误细节（boom），避免把内部错误泄漏给模型。
    expect(replaced.content[0].text).not.toContain('boom');
  });
});

describe('createVisionBridgeTransform (OpenAI Responses)', () => {
  it('replaces input_image items in input[].content', async () => {
    const t = makeTransform();
    const out = await t(
      {
        model: 'deepseek-v4',
        input: [
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'look' }] },
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_image', image_url: 'data:image/png;base64,QUJD' }],
          },
        ],
      },
      { reqId: 1, method: 'POST', url: '/v1/responses', headers: {} },
    );
    const input = (out as { input: unknown[] }).input;
    const content = (input[1] as { content: unknown[] }).content;
    const replaced = content[0] as { type: string; text: string };
    expect(replaced.type).toBe('input_text');
    expect(replaced.text).toContain('desc of');
  });

  it('short-circuits when shouldBridge is false', async () => {
    const t = makeTransform();
    const out = await t(
      {
        model: 'gpt-5.5',
        input: [
          { type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'data:x' }] },
        ],
      },
      { reqId: 1, method: 'POST', url: '/v1/responses', headers: {} },
    );
    expect(out).toBeNull();
  });
});

describe('layer B + layer A interlock (same describeImage instance)', () => {
  it('does not double-describe when B already replaced images with text', async () => {
    const describe = vi.fn(async () => 'b-layer description');
    const t = createVisionBridgeTransform({
      shouldBridge: (m) => m === 'deepseek-v4',
      describeImage: describe,
    });
    // 层 B 已把 image 替换为 text（见 vision-bridge.ts buildBridgedMessage）。
    const afterB = {
      model: 'deepseek-v4',
      messages: [
        { role: 'user', content: [{ type: 'text', text: '[用户贴了一张图片，已由外部多模态模型转成文字描述：]\n\nb-layer description' }] },
      ],
    };
    const out = await t(afterB, { reqId: 1, method: 'POST', url: '/v1/messages', headers: {} });
    // B 已处理后无 image job → A 短路透传，不再二次描述。
    expect(out).toBeNull();
    expect(describe).not.toHaveBeenCalled();
  });

  it('bridges when B passed through raw image (A as fallback)', async () => {
    const describe = vi.fn(async () => 'a-layer description');
    const t = createVisionBridgeTransform({
      shouldBridge: (m) => m === 'deepseek-v4',
      describeImage: describe,
    });
    // 层 B applied:false 原样透传的原始 image body → A 补位处理。
    const raw = {
      model: 'deepseek-v4',
      messages: [
        {
          role: 'user',
          content: [{ type: 'image', source: { type: 'url', url: 'https://x/y.png' } }],
        },
      ],
    };
    const out = await t(raw, { reqId: 1, method: 'POST', url: '/v1/messages', headers: {} });
    expect(out).not.toBeNull();
    expect(describe).toHaveBeenCalledTimes(1);
    const replaced = (out as { messages: unknown[] }).messages[0] as {
      content: Array<{ type: string; text: string }>;
    };
    expect(replaced.content[0].type).toBe('text');
    expect(replaced.content[0].text).toContain('a-layer description');
  });
});
