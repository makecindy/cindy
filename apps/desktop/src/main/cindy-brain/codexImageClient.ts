/**
 * ChatGPT/Codex OAuth image channel.
 *
 * Use the Codex standalone Images API with the selected ChatGPT account.
 * No Responses host model is needed. Catalog IDs remain compatibility handles;
 * the wire image model follows the upstream Codex image-generation extension.
 * Core validates and persists the returned image bytes through the existing path.
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';

import { normalizeImageParameters, type ImageParameters } from '../cindy-media/imageParameters.js';
import type { ImageChannel, ImageChannelResult } from './imageChannelRegistry.js';
import { mediaRequestParamsForLog, mediaRequestUrlForLog } from '../cindy-media/mediaRequestLog.js';
import { sniffMediaMime } from '../cindy-media/sniffMediaMime.js';
import { createLogger } from '../logger.js';

const CODEX_IMAGES_URL = 'https://chatgpt.com/backend-api/codex/images';
const IMAGE_MODEL = 'gpt-image-2';
const USER_AGENT = `codex_cli_rs/cindy (${process.platform}; ${process.arch})`;
const log = createLogger('codex-image');
export interface CreateCodexImageChannelOptions {
  providerId?: string;
  hasOAuthLogin(): boolean;
  getAuth(): Promise<{ accessToken: string; accountId: string | null }>;
  /** Best-effort handoff to the shared token-aware invalidation coordinator. */
  onAuthFailure?(failure: {
    status: number;
    body: string;
    failedAccessToken: string;
  }): void | Promise<void>;
  fetchImplementation?: typeof fetch;
  beforeDispatch?(model: string): void;
}

async function inputImage(path: string): Promise<{ image_url: string }> {
  const bytes = await fs.readFile(path);
  const mime = sniffMediaMime(bytes);
  if (!mime || !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mime)) {
    throw new Error(`OpenAI 参考图格式不支持:${mime ?? '未知格式'}`);
  }
  return { image_url: `data:${mime};base64,${bytes.toString('base64')}` };
}

async function httpError(
  response: Response,
  failedAccessToken: string,
  onAuthFailure: CreateCodexImageChannelOptions['onAuthFailure'],
): Promise<never> {
  const raw = await response.text().catch(() => '');
  try {
    await onAuthFailure?.({ status: response.status, body: raw, failedAccessToken });
  } catch (err) {
    // 失效态协调失败不能覆盖用户真正收到的上游 HTTP 错误，也不能记录 token。
    log.warn('Codex image auth invalidation failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  let detail = raw.slice(0, 500);
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: unknown } };
    if (typeof parsed.error?.message === 'string') detail = parsed.error.message.slice(0, 500);
  } catch {
    /* keep bounded raw body */
  }
  throw new Error(`Codex 图像请求失败(HTTP ${response.status}):${detail || '未知错误'}`);
}

export function createCodexImageChannel(opts: CreateCodexImageChannelOptions): ImageChannel {
  const doFetch = opts.fetchImplementation ?? fetch;

  async function generate(
    params: ImageParameters & {
      model: string;
      prompt: string;
      imagePaths?: string[];
      signal?: AbortSignal;
    },
    operation: 'generations' | 'edits',
  ): Promise<ImageChannelResult> {
    params.signal?.throwIfAborted();
    if (operation === 'edits' && !params.imagePaths?.length) {
      throw new Error('Codex image edit requires at least one reference image');
    }
    const options = normalizeImageParameters('openai', params.model, params);
    const modelPrefix = `${opts.providerId ?? 'openai'}/`;
    if (!params.model.startsWith(modelPrefix) || !params.model.slice(modelPrefix.length).trim()) {
      throw new Error(`Codex 图像通道不支持模型:${params.model}`);
    }
    // 先在 token 刷新 / 本地参考图读取之前拦停，后面的二次检查继续覆盖
    // 准备请求期间发生的模型停用。
    opts.beforeDispatch?.(params.model);
    const [auth, images] = await Promise.all([
      opts.getAuth(),
      Promise.all((params.imagePaths ?? []).map(inputImage)),
    ]);
    const currentAuth = await opts.getAuth();
    if (currentAuth.accessToken !== auth.accessToken || currentAuth.accountId !== auth.accountId) {
      throw new Error('Codex image account changed before dispatch');
    }
    opts.beforeDispatch?.(params.model);
    params.signal?.throwIfAborted();
    const url = CODEX_IMAGES_URL + '/' + operation;
    const body = {
      model: IMAGE_MODEL,
      prompt: params.prompt,
      ...options,
      background: 'opaque',
      ...(operation === 'edits' ? { images } : {}),
    };
    const requestId = randomUUID();
    const startedAt = Date.now();
    const requestLog = {
      requestId,
      providerId: opts.providerId ?? 'openai',
      modelId: params.model,
      method: 'POST',
      url: mediaRequestUrlForLog(url),
    };
    log.info('media request dispatch', {
      ...requestLog,
      params: mediaRequestParamsForLog(body),
    });
    let response: Response;
    try {
      response = await doFetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${auth.accessToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'x-codex-image-turn-id': requestId,
          originator: 'codex_cli_rs',
          'User-Agent': USER_AGENT,
          ...(auth.accountId ? { 'ChatGPT-Account-Id': auth.accountId } : {}),
        },
        body: JSON.stringify(body),
        signal: params.signal,
      });
      log.info('media request response', {
        ...requestLog,
        status: response.status,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      log.warn('media request failed', {
        ...requestLog,
        durationMs: Date.now() - startedAt,
        error: mediaRequestParamsForLog(error instanceof Error ? error.message : String(error)),
      });
      throw error;
    }
    if (!response.ok) await httpError(response, auth.accessToken, opts.onAuthFailure);
    const result = (await response.json()) as { data?: Array<{ b64_json?: unknown }> } | null;
    params.signal?.throwIfAborted();
    if (
      !Array.isArray(result?.data) ||
      !result.data.length ||
      result.data.some(
        (item) => !item || typeof item.b64_json !== 'string' || !item.b64_json.trim(),
      )
    ) {
      throw new Error('Codex 返回中没有图片,请重试或改用 OpenAI Platform API key');
    }
    // Do not infer output dimensions or format from the request. Core sniffs the bytes.
    return { data: result.data.map((item) => ({ b64_json: item.b64_json as string })) };
  }

  return {
    imageProtocol: 'openai',
    ready: opts.hasOAuthLogin,
    generateImage: (params) => generate(params, 'generations'),
    editImage: (params) => generate(params, 'edits'),
  };
}
