/**
 * geminiImageClient.ts — Google Gemini API(generativelanguage.googleapis.com)
 * 图像通道客户端(2026-07 图像多来源;BYO API key,无 Google OAuth)。
 * [PROTOCOL]: 变更时更新此头部,然后检查 CLAUDE.md
 *
 * wire 与 XD 网关的 OpenAI-images 兼容面完全不同(generateContent + inlineData),
 * 是唯一需要独立实现的图像 wire:
 *   - 生成:POST /v1beta/models/{upstreamId}:generateContent,text part + 可选
 *     generationConfig.imageConfig.aspectRatio(意识画幅意图 1:1/3:2/2:3 直传,
 *     Gemini 3 图像模型原生支持这些比例,ai.google.dev image-generation 文档);
 *   - 改图:同端点,参考图以 inlineData parts(base64)混入 contents;
 *   - 响应:candidates[0].content.parts[].inlineData{mimeType,data} 取首个图像
 *     part,适配成 ImageChannelResult(b64 + output_format)交给统一解码。
 *
 * 目录 id → upstream id:strip `gemini/` 前缀(目录 id 带 provider 前缀是跨供应商
 * 数据契约,防 first-wins 归属漂移;upstream GA id 即干净名,2026-05-28 GA)。
 * 鉴权:`x-goog-api-key` header,key 由 host 注入读取器(providerSecretStore),
 * 本模块不落盘、不打日志。纯逻辑 + 注入 fetch(规则 14),单测直测。
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import type { GhostImageAspectRatio } from '../../shared/ghost.js';
import type { ImageChannel, ImageChannelResult } from './imageChannelRegistry.js';

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

/** 参考图扩展名 → inlineData mime(与 index.ts 的 IMAGE_MIME_BY_EXT 同表,本模块自持避免循环依赖)。 */
const IMAGE_MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

interface GeminiInlineData {
  mimeType?: string;
  data?: string;
}

interface GeminiGenerateContentResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ inlineData?: GeminiInlineData; text?: string }> };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
  error?: { message?: string; status?: string };
}

export interface CreateGeminiImageChannelOptions {
  /** 读取用户的 Gemini API key(providerSecretStore('gemini'));null = 未配置。 */
  getApiKey(): string | null;
  fetchImplementation?: typeof fetch;
  /**
   * 派发前钩子(host 注入停用轴判定):payload 与凭证就绪、请求发出紧前调用,
   * 抛错即取消本次付费提交(与 gatewayImageClient.beforeDispatch 同语义)。
   */
  beforeDispatch?(model: string): void;
}

function upstreamModelId(catalogId: string): string {
  return catalogId.startsWith('gemini/') ? catalogId.slice('gemini/'.length) : catalogId;
}

function extractImage(body: GeminiGenerateContentResponse, model: string): ImageChannelResult {
  const blockReason = body.promptFeedback?.blockReason;
  if (blockReason) {
    throw new Error(`Gemini 拒绝了本次生成(安全策略:${blockReason}),请调整提示词后重试`);
  }
  const parts = body.candidates?.[0]?.content?.parts ?? [];
  const image = parts.find((p) => p.inlineData?.data);
  if (!image?.inlineData?.data) {
    const finish = body.candidates?.[0]?.finishReason;
    throw new Error(
      `Gemini 图像通道未返回图片(model ${JSON.stringify(model)}${finish ? `, finishReason ${finish}` : ''})`,
    );
  }
  const mime = image.inlineData.mimeType ?? 'image/png';
  return {
    data: [{ b64_json: image.inlineData.data }],
    output_format: mime.split('/')[1] ?? 'png',
  };
}

async function humanizeGeminiHttpError(res: Response, model: string): Promise<never> {
  const text = await res.text().catch(() => '');
  let upstreamMessage = '';
  try {
    const parsed = JSON.parse(text) as GeminiGenerateContentResponse;
    upstreamMessage = parsed.error?.message ?? '';
  } catch {
    upstreamMessage = text.slice(0, 200);
  }
  if (res.status === 400 && /API key not valid/i.test(upstreamMessage)) {
    throw new Error('Gemini API key 无效,请到「设置 → 模型供应商 → Google Gemini」检查后重新保存');
  }
  if (res.status === 429) {
    throw new Error('Gemini 图像配额已用尽或请求过于频繁,请稍后重试');
  }
  throw new Error(
    `Gemini image request failed (HTTP ${res.status}, model ${JSON.stringify(model)}): ${upstreamMessage || 'unknown error'}`,
  );
}

/**
 * 创建 Gemini 图像执行通道(ImageChannel 形状,直接挂 imageChannelRegistry)。
 * ready = key 已配置;generate/edit 共用 generateContent 端点(Gemini 的改图
 * 就是"参考图 + 指令"的多模态生成,无独立 edits 端点)。
 */
export function createGeminiImageChannel(opts: CreateGeminiImageChannelOptions): ImageChannel {
  const doFetch = opts.fetchImplementation ?? fetch;

  function requireApiKey(): string {
    const key = opts.getApiKey()?.trim() ?? '';
    if (!key) {
      throw new Error('Gemini API key 未配置,请到「设置 → 模型供应商 → Google Gemini」填入后重试');
    }
    return key;
  }

  async function callGenerateContent(params: {
    model: string;
    prompt: string;
    aspectRatio?: GhostImageAspectRatio;
    imagePaths?: string[];
  }): Promise<ImageChannelResult> {
    const apiKey = requireApiKey();
    const upstream = upstreamModelId(params.model);
    const parts: Array<Record<string, unknown>> = [{ text: params.prompt }];
    for (const p of params.imagePaths ?? []) {
      const mime = IMAGE_MIME_BY_EXT[path.extname(p).toLowerCase()];
      if (!mime) throw new Error(`参考图格式不支持:${path.extname(p) || '(无扩展名)'}`);
      const bytes = await fs.readFile(p);
      parts.push({ inlineData: { mimeType: mime, data: bytes.toString('base64') } });
    }
    const body: Record<string, unknown> = {
      contents: [{ parts }],
      generationConfig: {
        responseModalities: ['TEXT', 'IMAGE'],
        ...(params.aspectRatio ? { imageConfig: { aspectRatio: params.aspectRatio } } : {}),
      },
    };
    // 停用轴派发前重查:参考图 fs.readFile 是 await,窗口内被停用即拒(同 gatewayImageClient)。
    opts.beforeDispatch?.(params.model);
    const res = await doFetch(`${GEMINI_API_BASE}/models/${upstream}:generateContent`, {
      method: 'POST',
      headers: {
        'x-goog-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) await humanizeGeminiHttpError(res, params.model);
    const parsed = (await res.json()) as GeminiGenerateContentResponse;
    return extractImage(parsed, params.model);
  }

  return {
    ready: () => (opts.getApiKey()?.trim() ?? '') !== '',
    generateImage: ({ model, prompt, aspectRatio }) =>
      callGenerateContent({ model, prompt, aspectRatio }),
    editImage: ({ model, prompt, imagePaths, aspectRatio }) =>
      callGenerateContent({ model, prompt, imagePaths, aspectRatio }),
  };
}
