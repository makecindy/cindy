import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  GatewayImageEditParams,
  GatewayImageGenerateParams,
  GatewayImageResponse,
} from '../types.js';
import type { LiziMcpLogger } from '@cindy/mcps';
import type { CindyProxyMediaMaybePromise, CindyProxyMediaProxyConfig } from '../types.js';

export class GatewayImageError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = 'GatewayImageError';
  }
}

export interface CreateGatewayImageClientOptions {
  getApiKey(): CindyProxyMediaMaybePromise<string | null>;
  proxy: CindyProxyMediaProxyConfig;
  fetchImplementation?: typeof fetch;
  logger?: LiziMcpLogger;
  /**
   * 派发前钩子(host 注入停用轴判定):payload 与凭证就绪、请求发出紧前调用,
   * 抛错即取消本次付费提交(PR #744 review 第二十一轮)。缺席 = 不查。
   */
  beforeDispatch?(model: string): void;
  /**
   * 错误话术里的来源品牌名(2026-07 图像多来源:同一 OpenAI-images 兼容客户端被
   * xd 网关之外的来源复用,报错必须说清是哪家失败)。缺省 'XD Gateway'。
   */
  brandLabel?: string;
  /**
   * 该来源是否支持改图端点。false 时 editImage 直接人话明拒(不发请求)——
   * 不支持的来源静默把 edit 发到 generate 端点或吞参数都是错误路由。缺省 true。
   */
  supportsEdit?: boolean;
  /**
   * 该来源是否接受 size / quality 参数。false 时带这两个参数的请求明拒,
   * 不静默剥掉——静默降级会让调用方以为画幅/档位生效了。缺省 true。
   */
  allowSizeQuality?: boolean;
  /** 未配置凭证时的人话报错(各来源引导不同:xd 是登录飞书,BYO key 是去设置填 key)。 */
  missingKeyMessage?: string;
}

function gatewayErrorCode(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const parsed = body as {
    code?: unknown;
    error?: { code?: unknown; type?: unknown };
  };
  const value = parsed.error?.code ?? parsed.code ?? parsed.error?.type;
  return typeof value === 'string' || typeof value === 'number' ? String(value) : null;
}

function requestErrorMessage(params: {
  status: number;
  model: string;
  message: string;
  brandLabel: string;
  body?: unknown;
}): string {
  const code = gatewayErrorCode(params.body);
  const context = [
    `HTTP ${params.status}`,
    `model ${JSON.stringify(params.model)}`,
    ...(code ? [`code ${JSON.stringify(code)}`] : []),
  ].join(', ');
  return `${params.brandLabel} image request failed (${context}): ${params.message}`;
}

async function parseResponse(
  res: Response,
  model: string,
  brandLabel: string,
): Promise<GatewayImageResponse> {
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new GatewayImageError(
      requestErrorMessage({
        status: res.status,
        model,
        brandLabel,
        message: `non-JSON response: ${text.slice(0, 200)}`,
      }),
      res.status,
      text,
    );
  }

  if (!res.ok) {
    const errMsg =
      (parsed as { error?: { message?: string } })?.error?.message ??
      `${brandLabel} HTTP ${res.status}`;
    throw new GatewayImageError(
      requestErrorMessage({ status: res.status, model, brandLabel, message: errMsg, body: parsed }),
      res.status,
      parsed,
    );
  }

  const body = parsed as GatewayImageResponse;
  if (!body?.data || !Array.isArray(body.data) || body.data.length === 0) {
    throw new GatewayImageError(
      requestErrorMessage({
        status: res.status,
        model,
        brandLabel,
        message: 'response missing data[]',
        body: parsed,
      }),
      res.status,
      parsed,
    );
  }
  return body;
}

function mimeFromFilename(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  return 'image/jpeg';
}

export function createGatewayImageClient(opts: CreateGatewayImageClientOptions): {
  generateImage(
    params: GatewayImageGenerateParams,
    signal?: AbortSignal,
  ): Promise<GatewayImageResponse>;
  editImage(
    params: GatewayImageEditParams,
    signal?: AbortSignal,
  ): Promise<GatewayImageResponse>;
} {
  const beforeDispatch = opts.beforeDispatch;
  const brandLabel = opts.brandLabel ?? 'XD Gateway';
  const supportsEdit = opts.supportsEdit ?? true;
  const allowSizeQuality = opts.allowSizeQuality ?? true;
  const baseUrl = normalizeBaseUrl(opts.proxy.baseUrl);
  const generateUrl = joinProxyUrl(baseUrl, opts.proxy.generatePath);
  const editUrl = joinProxyUrl(baseUrl, opts.proxy.editPath);
  const doFetch = opts.fetchImplementation ?? fetch;

  async function requireApiKey(): Promise<string> {
    const key = await Promise.resolve(opts.getApiKey());
    if (!key) {
      throw new GatewayImageError(
        opts.missingKeyMessage ?? 'XD Gateway api key not found - please log in via Feishu first',
        401,
      );
    }
    return key;
  }

  function assertSizeQualityAllowed(params: { size?: string; quality?: string }): void {
    if (allowSizeQuality) return;
    if (params.size !== undefined || params.quality !== undefined) {
      throw new GatewayImageError(
        `${brandLabel} 图像通道不支持画幅/档位参数(size/quality),请去掉后重试`,
        400,
      );
    }
  }

  async function generateImage(
    params: GatewayImageGenerateParams,
    signal?: AbortSignal,
  ): Promise<GatewayImageResponse> {
    assertSizeQualityAllowed(params);
    const apiKey = await requireApiKey();
    const body: Record<string, unknown> = {
      model: params.model,
      prompt: params.prompt,
      n: params.n ?? 1,
      // 不接受 size 的来源连缺省 'auto' 也不发(assert 只能挡显式参数)。
      ...(allowSizeQuality ? { size: params.size ?? 'auto' } : {}),
    };
    if (params.quality) body.quality = params.quality;

    // 停用轴派发前重查(PR #744 review 第二十一轮):凭证获取是 await,期间该
    // (供应商, 模型) 可能被用户停用 —— payload 就绪、请求发出的紧前再验一次。
    beforeDispatch?.(params.model);
    const res = await doFetch(generateUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal,
    });
    return parseResponse(res, params.model, brandLabel);
  }

  async function editImage(
    params: GatewayImageEditParams,
    signal?: AbortSignal,
  ): Promise<GatewayImageResponse> {
    if (!supportsEdit) {
      throw new GatewayImageError(`${brandLabel} 图像通道不支持改图,请换支持改图的模型`, 400);
    }
    assertSizeQualityAllowed(params);
    const apiKey = await requireApiKey();
    if (params.imagePaths.length === 0) {
      throw new GatewayImageError('image_edit requires at least 1 image', 400);
    }

    const form = new FormData();
    form.append('model', params.model);
    form.append('prompt', params.prompt);
    form.append('n', String(params.n ?? 1));
    // 同 generateImage:不接受 size 的来源连缺省 'auto' 也不发。
    if (allowSizeQuality) form.append('size', params.size ?? 'auto');
    if (params.quality) form.append('quality', params.quality);

    for (const p of params.imagePaths) {
      const buf = await fs.readFile(p);
      const filename = path.basename(p);
      form.append('image[]', new Blob([buf], { type: mimeFromFilename(filename) }), filename);
    }

    // 同上:凭证获取 + 逐张 fs.readFile 都是 await,提交紧前重查。
    beforeDispatch?.(params.model);
    const res = await doFetch(editUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: form as unknown as BodyInit,
      signal,
    });
    return parseResponse(res, params.model, brandLabel);
  }

  return { generateImage, editImage };
}

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (!trimmed) {
    throw new Error('art: proxy.baseUrl is required');
  }
  return trimmed.replace(/\/+$/, '');
}

function joinProxyUrl(baseUrl: string, endpointPath: string): string {
  const trimmed = endpointPath.trim();
  if (!trimmed) {
    throw new Error('art: proxy endpoint path is required');
  }
  return `${baseUrl}/${trimmed.replace(/^\/+/, '')}`;
}
