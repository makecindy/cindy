/**
 * xAI Imagine image channel backed by the user's existing SuperGrok OAuth login.
 *
 * The OAuth bearer used by the xAI agent bridge also works on the OpenAI-compatible
 * Imagine endpoints. Credentials stay in Main; local source images are sent as data
 * URIs and the response is normalized to ImageChannelResult.
 */

import fs from 'node:fs/promises';

import type { GhostImageAspectRatio } from '../../shared/ghost.js';
import { sniffMediaMime } from '../cindy-media/sniffMediaMime.js';
import type { ImageChannel, ImageChannelResult } from './imageChannelRegistry.js';

const XAI_API_BASE = 'https://api.x.ai/v1';
const MAX_EDIT_SOURCES = 3;

interface XaiImageResponse {
  data?: Array<{
    b64_json?: string;
    url?: string;
    mime_type?: string;
  }>;
  error?: { message?: string };
}

export interface CreateXaiImageChannelOptions {
  hasOAuthLogin(): boolean;
  getAccessToken(): Promise<string>;
  fetchImplementation?: typeof fetch;
  beforeDispatch?(model: string): void;
  onAuthRejected?(failure: {
    status: number;
    body: string;
    failedAccessToken: string;
  }): Promise<unknown>;
}

function upstreamModelId(catalogId: string): string {
  return catalogId.startsWith('xai/') ? catalogId.slice('xai/'.length) : catalogId;
}

async function sourceImage(path: string): Promise<{ type: 'image_url'; url: string }> {
  const bytes = await fs.readFile(path);
  const mime = sniffMediaMime(bytes);
  if (!mime || !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mime)) {
    throw new Error(`xAI 参考图格式不支持:${mime ?? '未知格式'}`);
  }
  return { type: 'image_url', url: `data:${mime};base64,${bytes.toString('base64')}` };
}

function parseResponse(text: string): XaiImageResponse {
  try {
    return JSON.parse(text) as XaiImageResponse;
  } catch {
    throw new Error('xAI 图像通道返回了无效响应');
  }
}

function assertXaiImageUrl(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || !(url.hostname === 'x.ai' || url.hostname.endsWith('.x.ai'))) {
    throw new Error('xAI 图像通道返回了不可信的图片地址');
  }
  return url.toString();
}

export function createXaiImageChannel(opts: CreateXaiImageChannelOptions): ImageChannel {
  const doFetch = opts.fetchImplementation ?? fetch;

  async function call(params: {
    model: string;
    prompt: string;
    aspectRatio?: GhostImageAspectRatio;
    imagePaths?: string[];
  }): Promise<ImageChannelResult> {
    const paths = params.imagePaths ?? [];
    if (paths.length > MAX_EDIT_SOURCES) {
      throw new Error(`xAI 图像编辑最多支持 ${MAX_EDIT_SOURCES} 张源图`);
    }
    // 先在任何凭证刷新或本地文件读取之前拦截已停用模型；后面的二次检查
    // 继续覆盖准备请求期间发生的配置变化。
    opts.beforeDispatch?.(params.model);
    const [token, images] = await Promise.all([
      opts.getAccessToken(),
      Promise.all(paths.map(sourceImage)),
    ]);
    const isEdit = images.length > 0;
    const body: Record<string, unknown> = {
      model: upstreamModelId(params.model),
      prompt: params.prompt,
      response_format: 'b64_json',
      resolution: '1k',
      ...(params.aspectRatio ? { aspect_ratio: params.aspectRatio } : {}),
    };
    if (isEdit) {
      if (images.length === 1) body.image = images[0];
      else body.images = images;
    }

    opts.beforeDispatch?.(params.model);
    const response = await doFetch(`${XAI_API_BASE}/images/${isEdit ? 'edits' : 'generations'}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
    });
    const responseText = await response.text();
    if (!response.ok) {
      if ((response.status === 401 || response.status === 403) && opts.onAuthRejected) {
        await opts
          .onAuthRejected({
            status: response.status,
            body: responseText.slice(0, 8 * 1024),
            failedAccessToken: token,
          })
          .catch(() => undefined);
      }
      const parsed = (() => {
        try {
          return JSON.parse(responseText) as XaiImageResponse;
        } catch {
          return null;
        }
      })();
      const detail = parsed?.error?.message ?? (responseText.slice(0, 500) || '未知错误');
      throw new Error(`xAI 图像请求失败(HTTP ${response.status}):${detail}`);
    }

    const parsed = parseResponse(responseText);
    const first = parsed.data?.[0];
    if (first?.b64_json) {
      return {
        data: [{ b64_json: first.b64_json }],
        output_format: first.mime_type?.split('/')[1] ?? 'png',
      };
    }
    if (first?.url) {
      // Imagine URLs are short-lived. Materialize immediately so the shared media
      // pipeline receives stable bytes instead of persisting an expiring URL.
      const imageResponse = await doFetch(assertXaiImageUrl(first.url), { redirect: 'manual' });
      if (!imageResponse.ok) {
        throw new Error(`xAI 图片下载失败(HTTP ${imageResponse.status})`);
      }
      const bytes = Buffer.from(await imageResponse.arrayBuffer());
      const mime = sniffMediaMime(bytes);
      if (!mime?.startsWith('image/')) throw new Error('xAI 图片下载结果不是有效图片');
      return { data: [{ b64_json: bytes.toString('base64') }], output_format: mime.split('/')[1] };
    }
    throw new Error('xAI 图像通道未返回图片');
  }

  return {
    ready: opts.hasOAuthLogin,
    generateImage: ({ model, prompt, aspectRatio }) => call({ model, prompt, aspectRatio }),
    editImage: ({ model, prompt, imagePaths, aspectRatio }) =>
      call({ model, prompt, imagePaths, aspectRatio }),
  };
}
