/**
 * ChatGPT/Codex OAuth image channel.
 *
 * The subscription token cannot call the public Platform Images API. It can,
 * however, call the Codex Responses surface and expose `gpt-image-2` through
 * the hosted `image_generation` tool. Keep the token in Main and parse the raw
 * SSE stream because image-generation events may be newer than SDK typings.
 */

import fs from 'node:fs/promises';

import type { ImageChannel, ImageChannelResult } from './imageChannelRegistry.js';
import { sniffMediaMime } from '../cindy-media/sniffMediaMime.js';

const CODEX_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';
const HOST_MODEL = 'gpt-5.5';
const IMAGE_MODEL = 'gpt-image-2';
const USER_AGENT = `codex_cli_rs/cindy (${process.platform}; ${process.arch})`;
const SIZE_BY_ASPECT = {
  '1:1': '1024x1024',
  '3:2': '1536x1024',
  '2:3': '1024x1536',
} as const;

export interface CreateCodexImageChannelOptions {
  hasOAuthLogin(): boolean;
  getAccessToken(): Promise<string | null>;
  getAccountId(): Promise<string | null>;
  fetchImplementation?: typeof fetch;
  beforeDispatch?(model: string): void;
}

function extractImageB64(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractImageB64(item);
      if (found) return found;
    }
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  if (item.type === 'image_generation_call' && typeof item.result === 'string') return item.result;
  if (typeof item.partial_image_b64 === 'string') return item.partial_image_b64;
  for (const child of Object.values(item)) {
    const found = extractImageB64(child);
    if (found) return found;
  }
  return null;
}

async function collectImageB64(response: Response): Promise<string | null> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let latest: string | null = null;
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = block
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (data && data !== '[DONE]') {
        const found = extractImageB64(JSON.parse(data) as unknown);
        if (found) latest = found;
      }
      boundary = buffer.indexOf('\n\n');
    }
    if (done) break;
  }
  return latest;
}

async function inputImage(path: string): Promise<{ type: 'input_image'; image_url: string }> {
  const bytes = await fs.readFile(path);
  const mime = sniffMediaMime(bytes);
  if (!mime || !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mime)) {
    throw new Error(`OpenAI 参考图格式不支持:${mime ?? '未知格式'}`);
  }
  return { type: 'input_image', image_url: `data:${mime};base64,${bytes.toString('base64')}` };
}

async function httpError(response: Response): Promise<never> {
  const raw = await response.text().catch(() => '');
  let detail = raw.slice(0, 500);
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: unknown } };
    if (typeof parsed.error?.message === 'string') detail = parsed.error.message.slice(0, 500);
  } catch { /* keep bounded raw body */ }
  throw new Error(`Codex 图像请求失败(HTTP ${response.status}):${detail || '未知错误'}`);
}

export function createCodexImageChannel(opts: CreateCodexImageChannelOptions): ImageChannel {
  const doFetch = opts.fetchImplementation ?? fetch;

  async function generate(params: {
    model: string;
    prompt: string;
    imagePaths?: string[];
    aspectRatio?: '1:1' | '3:2' | '2:3';
  }): Promise<ImageChannelResult> {
    const [token, accountId, images] = await Promise.all([
      opts.getAccessToken(),
      opts.getAccountId(),
      Promise.all((params.imagePaths ?? []).map(inputImage)),
    ]);
    if (!token) throw new Error('OpenAI 订阅登录已失效,请在「设置 → 模型供应商 → OpenAI」重新登录');
    opts.beforeDispatch?.(params.model);
    const content: Array<Record<string, unknown>> = [
      { type: 'input_text', text: params.prompt },
      ...images,
    ];
    const response = await doFetch(CODEX_RESPONSES_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        'OpenAI-Beta': 'responses=experimental',
        originator: 'codex_cli_rs',
        'User-Agent': USER_AGENT,
        ...(accountId ? { 'ChatGPT-Account-Id': accountId } : {}),
      },
      body: JSON.stringify({
        model: HOST_MODEL,
        store: false,
        stream: true,
        instructions: 'Use the image_generation tool to fulfill this image request.',
        input: [{ type: 'message', role: 'user', content }],
        tools: [{
          type: 'image_generation',
          model: IMAGE_MODEL,
          size: params.aspectRatio ? SIZE_BY_ASPECT[params.aspectRatio] : '1024x1024',
          quality: 'medium',
          output_format: 'png',
          background: 'opaque',
          partial_images: 1,
        }],
      }),
    });
    if (!response.ok) await httpError(response);
    const b64 = await collectImageB64(response);
    if (!b64) throw new Error('Codex 返回中没有图片,请重试或改用 OpenAI Platform API key');
    return { data: [{ b64_json: b64 }], output_format: 'png' };
  }

  return {
    ready: opts.hasOAuthLogin,
    generateImage: ({ model, prompt, aspectRatio }) => generate({ model, prompt, aspectRatio }),
    editImage: ({ model, prompt, imagePaths, aspectRatio }) =>
      generate({ model, prompt, imagePaths, aspectRatio }),
  };
}
