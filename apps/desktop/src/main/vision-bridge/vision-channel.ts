/**
 * vision-channel —— 视觉桥的 image→text 执行通道（层 B/A 共用）。
 *
 * 复用设置页里已配好的 provider 作为视觉后端。路由解析复用统一路由器（host 注入
 * `provider-route.resolveVisionBackendRoute`，与 agent 路由完全同源）：按模型归属选
 * agent 面（xd 投影模型走 Claude Messages 面）、按 `routing.modelIdRewrite` 剥前缀、
 * `gateway-key` 走动态租户端点、按 `routing.wireProtocol` 构造三协议请求/解析响应。
 *
 * 对齐 docs/vision-bridge-design.md 五、视觉通道：
 *  - 不新增独立配置/凭证体系，复用 provider 的 key（自定义 provider key / 网关 key）；
 *  - 支持主/fallback 双后端（fallback 编排在调用方，见 vision-bridge.ts）；
 *  - 失败不静默：抛带原因的 VisionBackendError，由调用方决定 fallback 或回退无视觉桥。
 *
 * 第一版边界（诚实标注）：
 *  - 请求协议按 routing.wireProtocol 支持 openai-chat / openai-responses /
 *    anthropic-messages 三种；OAuth 系 authStrategy（oauth-passthrough /
 *    provider-oauth-header / oauth-token）暂不支持 —— 该后端判为不可用，走 fallback/回退。
 */
import fs from 'node:fs/promises';

import type { AgentKind } from '@cindy/model-providers';
import type { Provider } from '@cindy/model-providers';

/** 视觉后端执行失败（带原因）。调用方据此决定 fallback 或回退。 */
export class VisionBackendError extends Error {
  readonly code: 'unsupported-auth' | 'not-found' | 'http' | 'network' | 'timeout' | 'abort' | 'empty' | 'unsupported-image' | 'unavailable';
  constructor(
    code: VisionBackendError['code'],
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'VisionBackendError';
    this.code = code;
  }
}

/** 视觉通道的可注入依赖（host 装配；单测注入 fake）。 */
export interface VisionChannelDeps {
  /** 从 active-catalog 找 provider（按 providerId）。 */
  getProviderById: (providerId: string) => Provider | null;
  /** 读自定义 provider 的 api key。缺省 = 自定义 provider 后端不可用。 */
  readCustomProviderKey?: (providerId: string, agent: AgentKind) => string | null;
  /** 读 XD 网关 key。缺省 = 网关后端不可用。 */
  readGatewayKey?: () => string | null;
  /**
   * 解析 XD 网关的真实推理入口（随凭据下发的租户端点）。缺省 = 直接用 routing.upstream。
   * 对齐 model-access/effectiveEndpoint.ts 的「key 与 endpoint 永远同租户」不变量：
   * `gateway-key` 路由的 builtin upstream 是占位地址（xd-gateway.invalid），真实入口必须
   * 经此函数获取；拿不到（未登录 / 无 server 标记 / 网关不可用）返回 null，调用方判不可用。
   */
  resolveGatewayEndpoint?: () => string | null;
  /**
   * 解析视觉后端的真实出站端点（与 agent 路由同源）。host 装配时注入
   * `provider-route.resolveVisionBackendRoute`（含 xd 特例 / modelIdRewrite / 动态端点 /
   * 凭证），视觉桥不自己复刻路由判断。返回 null = 后端不可用（走 fallback/回退）。
   */
  resolveBackendRoute?: (
    providerId: string,
    modelId: string,
  ) => VisionBackendEndpoint | null;
  /** 出网 fetch（对齐签名）。缺省 = globalThis.fetch。 */
  fetch?: typeof globalThis.fetch;
  /** 单次视觉调用的软超时（ms）。缺省 30000——视觉推理（尤其带图）常需 10-30s，5s 太短易超时。 */
  timeoutMs?: number;
}

export interface VisionChannelInput {
  /** 图片来源之一：本地绝对路径。 */
  imagePath?: string;
  /** 图片来源之一：http(s) / data: URL。 */
  imageUrl?: string;
  /** focus hint / 视觉 prompt。缺省 = 通用描述指令。 */
  prompt?: string;
  /** 调用方取消信号（turn abort）。传给 fetch 让 Stop/取消能中止视觉请求。 */
  signal?: AbortSignal;
}

export const DEFAULT_VISION_PROMPT =
  'Describe this image accurately and factually. Do NOT guess or fabricate details. ' +
  'Report visible text verbatim. If the image contains UI elements, lists their labels and state.';

/** anthropic-messages 视觉请求的 max_tokens（/v1/messages 强制要求，缺省 400）。
 *  描述文本通常远小于此，取有界值防超长输出。 */
const VISION_ANTHROPIC_MAX_TOKENS = 1024;

/** 允许直接转为 data URL 的图片 mime（对齐 vision_client.py）。 */
const ALLOWED_IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

/** 图片魔数识别：非真实图片字节直接拒绝，阻断把任意本地文件当图外传（与 Pi 侧同款）。 */
function sniffImageMime(buf: Buffer): string | null {
  if (buf.length < 12) return null;
  // PNG: 89 50 4E 47
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  // GIF: 47 49 46 38
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'image/gif';
  // WebP: RIFF .... WEBP
  if (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) return 'image/webp';
  return null;
}

/** 图片字节上限（防大图 base64 撑爆内存峰值）。超过拒绝，提示压缩。 */
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
/** 视觉描述最大字符数（防异常后端返回超大 content 撑爆内存与上下文）。 */
export const MAX_DESCRIPTION_CHARS = 32 * 1024;

/** 图片 → data URL。读文件失败 / 非真实图片 / 超大 / 不支持格式抛 VisionBackendError。 */
async function toDataUrl(imagePath: string): Promise<string> {
  try {
    const st = await fs.stat(imagePath);
    if (st.size > MAX_IMAGE_BYTES) {
      // 脱敏：不把本地路径/文件名写进错误 message（日志可能被上传/外发，路径是敏感元数据）。
      throw new VisionBackendError(
        'unsupported-image',
        `image too large (${st.size} bytes, limit ${MAX_IMAGE_BYTES})`,
      );
    }
  } catch (err) {
    if (err instanceof VisionBackendError) throw err;
    throw new VisionBackendError('unsupported-image', 'stat image failed', err);
  }
  let data: Buffer;
  try {
    data = await fs.readFile(imagePath);
  } catch (err) {
    throw new VisionBackendError('unsupported-image', 'read image failed', err);
  }
  // TOCTOU 复查：stat 后、read 前文件可能被替换/增大，读后按实际字节数再查一次上限。
  if (data.length > MAX_IMAGE_BYTES) {
    throw new VisionBackendError(
      'unsupported-image',
      `image too large after read (${data.length} bytes, limit ${MAX_IMAGE_BYTES})`,
    );
  }
  // 安全：只允许真实图片字节（魔数校验），防止任意文件（.env / 密钥 / 文档）base64 外传。
  const mime = sniffImageMime(data);
  if (!mime) {
    throw new VisionBackendError('unsupported-image', 'not a supported image (magic-byte check failed)');
  }
  return `data:${mime};base64,${data.toString('base64')}`;
}

/**
 * 选该 provider 用于视觉的 agent 面。跟 agent 路由一致：先按模型 id 前缀判定面
 * （`codex/` → codex 面、`claude-`/`anthropic/` → claude-code 面），再按 provider.models
 * 里模型归属，最后回退到第一个声明 routing 的 agent。避免「模型是 codex 面却走了
 * claude-code 的 routing」导致协议/端点不匹配。
 */
function pickAgent(provider: Provider, modelId: string): AgentKind | null {
  // 模型前缀显式指面（对齐 codex-proxy 的 `model.startsWith('codex/')` 判定）。
  if (modelId.startsWith('codex/') && provider.routing.codex) return 'codex';
  if (
    (modelId.startsWith('claude-') || modelId.startsWith('anthropic/')) &&
    provider.routing['claude-code']
  ) {
    return 'claude-code';
  }
  // 模型在某 agent 的 models 清单里 → 走该 agent 面（对齐 registry.providerOffersModel）。
  for (const agent of provider.agents) {
    if ((provider.models[agent] ?? []).some((m) => m.id === modelId) && provider.routing[agent]) {
      return agent;
    }
  }
  // 回退：第一个声明 routing 的 agent。
  const preferred: AgentKind[] = ['claude-code', 'codex', 'pi'];
  for (const agent of preferred) {
    if (provider.agents.includes(agent) && provider.routing[agent]) return agent;
  }
  return null;
}

/** 按 agent 面推断缺省 wireProtocol（对齐 user-provider defaultWireProtocol）。 */
function defaultWireProtocol(agent: AgentKind): 'anthropic-messages' | 'openai-responses' | 'openai-chat' {
  if (agent === 'claude-code') return 'anthropic-messages';
  if (agent === 'codex') return 'openai-responses';
  return 'openai-chat';
}

/**
 * 转发上游前还原 model id：按 routing.modelIdRewrite.stripPrefix 剥前缀（对齐
 * codex-proxy 的 rewriteChatBridgeModel）。如 `codex/gpt-5.6-luna` → `gpt-5.6-luna`。
 */
function rewriteVisionModel(modelId: string, stripPrefix: string | undefined): string {
  return stripPrefix && modelId.startsWith(stripPrefix)
    ? modelId.slice(stripPrefix.length)
    : modelId;
}

/** 从 routing 读 wireProtocol，缺省按 agent 面推断。 */
function wireProtocolFor(provider: Provider, agent: AgentKind): 'anthropic-messages' | 'openai-responses' | 'openai-chat' {
  return provider.routing[agent]?.wireProtocol ?? defaultWireProtocol(agent);
}

/** 视觉桥请求应带的路由额外头（headerOverride 去掉客户端凭证头）。
 *  视觉桥直连不发 proxy，需自己带上 anthropic-version / x-api-key / 自定义 provider 头
 *  （与代理层 withoutClientAuthHeaders 对齐，防 catalog 误配把客户端凭证带进第三方）。 */
const VISION_CLIENT_AUTH_HEADERS = new Set(['authorization', 'x-api-key']);
function visionRouteHeaders(routing: Provider['routing'][AgentKind] | undefined): Record<string, string> {
  const override = routing?.headerOverride;
  if (!override) return {};
  return Object.fromEntries(
    Object.entries(override).filter(([name]) => !VISION_CLIENT_AUTH_HEADERS.has(name.toLowerCase())),
  );
}

/** 按 wireProtocol 推断缺省请求路径（对齐上游标准路径）。 */
function defaultRequestPath(wire: 'anthropic-messages' | 'openai-responses' | 'openai-chat'): string {
  if (wire === 'anthropic-messages') return '/v1/messages';
  if (wire === 'openai-responses') return '/responses';
  return '/chat/completions';
}

function resolveImageUrl(input: VisionChannelInput): Promise<string> {
  if (input.imageUrl) return Promise.resolve(input.imageUrl);
  if (input.imagePath) return toDataUrl(input.imagePath);
  return Promise.reject(new VisionBackendError('unsupported-image', 'no image source provided'));
}

function applyAuthStrategy(
  provider: Provider,
  agent: AgentKind,
  deps: VisionChannelDeps,
): Record<string, string> {
  const routing = provider.routing[agent];
  if (!routing) return {};
  switch (routing.authStrategy) {
    case 'api-key-header': {
      const key = deps.readCustomProviderKey?.(provider.id, agent) ?? null;
      if (!key) throw new VisionBackendError('unavailable', `no api key for provider ${provider.id}`);
      return { authorization: `Bearer ${key}` };
    }
    case 'none':
      return {};
    case 'gateway-key': {
      const key = deps.readGatewayKey?.() ?? null;
      if (!key) throw new VisionBackendError('unavailable', 'gateway key unavailable');
      return { authorization: `Bearer ${key}` };
    }
    default:
      throw new VisionBackendError(
        'unsupported-auth',
        `provider ${provider.id} uses auth strategy ${routing.authStrategy}, not supported as vision backend yet`,
      );
  }
}

/**
 * 用指定 provider + model 描述一张图。成功返回描述文本；失败抛 VisionBackendError。
 */
export async function describeImageWithProvider(
  providerId: string,
  modelId: string,
  input: VisionChannelInput,
  deps: VisionChannelDeps,
): Promise<string> {
  // 取消时尽早失败，不做本地读/授权前置处理（归 abort 而非 network，便于区分 Stop/取消）。
  if (input.signal?.aborted) {
    throw new VisionBackendError('abort', 'vision request cancelled');
  }
  // 复用 resolveVisionBackendEndpoint：host 注入的与 agent 路由同源解析优先（xd 特例 /
  // modelIdRewrite / 动态端点 / 凭证）；注入的 resolver 返回 null 时直接判 unavailable，
  // 绝不回退内置解析（保持「与 agent 路由完全同源」口径，避免 A/B 与 C 层分叉）。
  const endpoint = resolveVisionBackendEndpoint(providerId, modelId, deps);
  const url = `${endpoint.upstream}${endpoint.requestPath.startsWith('/') ? endpoint.requestPath : `/${endpoint.requestPath}`}`;
  // 合并路由额外头（anthropic-version / x-api-key / 自定义 provider 头）+ Authorization。
  // endpoint.headers 已过滤客户端凭证头，与 authorization 无冲突。
  const headers: Record<string, string> = {
    ...endpoint.headers,
    ...(endpoint.authorization ? { authorization: endpoint.authorization } : {}),
  };
  const imageUrl = await resolveImageUrl(input);
  const prompt = input.prompt && input.prompt.trim().length > 0 ? input.prompt.trim() : DEFAULT_VISION_PROMPT;

  // 按 wire 协议构造对应请求体（对齐 agent 上游形态）：
  //  - openai-chat → messages[].content[] 里 image_url
  //  - openai-responses → input[].content[] 里 input_image
  //  - anthropic-messages → messages[].content[] 里 image block
  const body = buildVisionRequestBody(endpoint.wireProtocol, endpoint.model, prompt, imageUrl);

  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const timeoutMs = deps.timeoutMs ?? 30000;
  let res: Response;
  // 组合 signal：调用方取消（turn abort）+ 超时。Stop/取消能中止视觉请求，不再等超时。
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const effectiveSignal = input.signal
    ? AbortSignal.any([input.signal, timeoutSignal])
    : timeoutSignal;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      // 安全：视觉请求携带 Authorization 头与图片内容，跟随 30x 重定向会把凭证/图片
      // 发往非预期端点。显式拒绝重定向（fetch 对 30x 回原样响应，调用方按 !res.ok 处理）。
      redirect: 'error',
      signal: effectiveSignal,
    });
  } catch (err) {
    // 区分取消/超时/网络：便于诊断（Stop 取消 vs 后端超时 vs DNS/连接失败）。
    if (effectiveSignal.aborted) {
      if (input.signal?.aborted) {
        throw new VisionBackendError('abort', 'vision request cancelled');
      }
      throw new VisionBackendError('timeout', `vision request timed out: ${url}`);
    }
    throw new VisionBackendError('network', `vision request failed: ${url}`, err);
  }
  if (!res.ok) {
    let bodyText = '';
    try {
      bodyText = (await res.text()).slice(0, 512);
    } catch {
      // 忽略 body 读取失败
    }
    throw new VisionBackendError('http', `vision backend returned ${res.status}`, bodyText);
  }
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch (err) {
    // 2xx 但响应非 JSON：后端协议错（非网络问题），归 http 以便诊断。
    throw new VisionBackendError('http', 'vision backend returned non-JSON response', err);
  }
  const content = extractVisionContent(parsed, endpoint.wireProtocol);
  if (!content || content.trim().length === 0) {
    throw new VisionBackendError('empty', 'vision backend returned empty description');
  }
  // 裁剪超长描述（异常/恶意后端可返回超大 content，撑爆内存与上下文）。
  const trimmed = content.trim();
  return trimmed.length > MAX_DESCRIPTION_CHARS
    ? `${trimmed.slice(0, MAX_DESCRIPTION_CHARS)}…[truncated]`
    : trimmed;
}

/** 从各协议响应抽文字描述。返回 null 表示无描述（空响应）。 */
export function extractVisionContent(
  parsed: unknown,
  wireProtocol: VisionWireProtocol,
): string | null {
  if (wireProtocol === 'openai-chat') return extractChatContent(parsed);
  if (wireProtocol === 'anthropic-messages') return extractAnthropicContent(parsed);
  return extractResponsesContent(parsed);
}

/** 从 OpenAI chat /chat/completions 响应抽 choices[0].message.content。 */
export function extractChatContent(parsed: unknown): string | null {
  const choices = (parsed as { choices?: unknown })?.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0] as { message?: { content?: unknown } };
  const content = first?.message?.content;
  if (typeof content === 'string') return content.trim().length > 0 ? content : null;
  // 部分端点返回 content 为 part 数组。
  if (Array.isArray(content)) {
    const parts = content
      .map((part) => {
        if (part && typeof part === 'object') {
          const t = (part as { text?: unknown }).text;
          return typeof t === 'string' ? t : '';
        }
        return '';
      })
      .join('');
    return parts.length > 0 ? parts : null;
  }
  return null;
}

/** 从 Anthropic Messages 响应抽 content[].text 拼接。 */
export function extractAnthropicContent(parsed: unknown): string | null {
  const content = (parsed as { content?: unknown })?.content;
  if (!Array.isArray(content)) return null;
  const parts = content
    .map((block) => {
      if (block && typeof block === 'object') {
        const t = (block as { type?: unknown; text?: unknown }).text;
        return typeof t === 'string' ? t : '';
      }
      return '';
    })
    .join('');
  return parts.trim().length > 0 ? parts : null;
}

/** 从 OpenAI Responses 响应抽 output[].content[].text 拼接。 */
export function extractResponsesContent(parsed: unknown): string | null {
  const output = (parsed as { output?: unknown })?.output;
  if (!Array.isArray(output)) return null;
  const parts: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== 'object') continue;
    const it = item as { type?: unknown; content?: unknown };
    // output_text 直接是文本；message.content[] 里是 text 块。
    if (it.type === 'output_text' && typeof (it as { text?: unknown }).text === 'string') {
      parts.push((it as { text: string }).text);
    }
    if (Array.isArray(it.content)) {
      for (const block of it.content) {
        if (block && typeof block === 'object') {
          const b = block as { type?: unknown; text?: unknown };
          if (b.type === 'output_text' || b.type === 'text') {
            if (typeof b.text === 'string') parts.push(b.text);
          }
        }
      }
    }
  }
  return parts.join('').trim().length > 0 ? parts.join('') : null;
}

/**
 * 构造视觉请求体（按 wire 协议）。imageUrl 为 data URL 或 http(s) URL。
 * 对齐 agent 上游形态：openai-chat 用 image_url；openai-responses 用 input_image；
 * anthropic-messages 用 image block（base64 或 url source）。
 */
function buildVisionRequestBody(
  wireProtocol: VisionWireProtocol,
  model: string,
  prompt: string,
  imageUrl: string,
): Record<string, unknown> {
  if (wireProtocol === 'openai-chat') {
    return {
      model,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: imageUrl } },
          ],
        },
      ],
    };
  }
  if (wireProtocol === 'openai-responses') {
    return {
      model,
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: prompt },
            { type: 'input_image', image_url: imageUrl },
          ],
        },
      ],
    };
  }
  // anthropic-messages：image block source 用 url（data URL 也按 Anthropic url source 支持
  // 与否取决于上游；本地 data URL 转 base64 source 最稳）。
  const source = imageUrl.startsWith('data:')
    ? dataUrlToAnthropicSource(imageUrl)
    : { type: 'url', url: imageUrl };
  // /v1/messages 强制要求 max_tokens，缺省会 400（视觉桥描述文本短，1024 足够且有界）。
  return {
    model,
    max_tokens: VISION_ANTHROPIC_MAX_TOKENS,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image', source },
        ],
      },
    ],
  };
}

/** data:image/png;base64,xxx → { type:'base64', media_type, data }。 */
function dataUrlToAnthropicSource(
  dataUrl: string,
): { type: 'base64'; media_type: string; data: string } {
  const comma = dataUrl.indexOf(',');
  const meta = comma === -1 ? '' : dataUrl.slice(0, comma);
  const data = comma === -1 ? dataUrl : dataUrl.slice(comma + 1);
  const mediaMatch = /^data:([^;,]+)/.exec(meta);
  return { type: 'base64', media_type: mediaMatch?.[1] ?? 'image/png', data };
}

/** 视觉后端请求 wire 协议（对齐 ProviderWireProtocol）。 */
export type VisionWireProtocol = 'anthropic-messages' | 'openai-responses' | 'openai-chat';

/** 解析后的视觉后端端点元数据（供 pi 子进程 env 注入等 host 侧复用）。 */
export interface VisionBackendEndpoint {
  /** 上游 base（不含尾斜杠）。 */
  upstream: string;
  /** 请求相对路径（按协议推断缺省）。 */
  requestPath: string;
  /** 真实模型 id。 */
  model: string;
  /** Authorization 头值（`Bearer <key>`）；无鉴权为 null。 */
  authorization: string | null;
  /** 路由指定的额外请求头（headerOverride 去掉客户端凭证头）；视觉桥直连需带上，
   *  否则后端可能因缺 anthropic-version / x-api-key / 自定义 provider 头而拒绝（P1）。 */
  headers: Record<string, string>;
  /** wire 协议（决定请求体/响应解析形态）。 */
  wireProtocol: VisionWireProtocol;
}

/**
 * 解析某 provider + model 的视觉后端端点。authStrategy 不支持（OAuth 系）或凭证缺失
 * 时抛 VisionBackendError（调用方据此把该后端判为不可用）。
 */
export function resolveVisionBackendEndpoint(
  providerId: string,
  modelId: string,
  deps: VisionChannelDeps,
): VisionBackendEndpoint {
  // host 注入的与 agent 路由同源解析优先（xd 特例 / modelIdRewrite / 动态端点 / 凭证）。
  if (deps.resolveBackendRoute) {
    const routed = deps.resolveBackendRoute(providerId, modelId);
    if (!routed) {
      throw new VisionBackendError(
        'unavailable',
        `vision backend unavailable for provider ${providerId} model ${modelId} (no usable route)`,
      );
    }
    return routed;
  }
  // 缺省回退：内置 provider-scoped 解析。
  const provider = deps.getProviderById(providerId);
  if (!provider) {
    throw new VisionBackendError('not-found', `vision backend provider not found: ${providerId}`);
  }
  const agent = pickAgent(provider, modelId);
  if (!agent) {
    throw new VisionBackendError('not-found', `provider ${providerId} has no usable routing`);
  }
  const routing = provider.routing[agent]!;
  const wireProtocol = wireProtocolFor(provider, agent);
  const requestPath = routing.requestPath ?? defaultRequestPath(wireProtocol);
  // gateway-key 路由的 builtin upstream 是占位地址（如 xd-gateway.invalid），真实入口必须
  // 经 deps.resolveGatewayEndpoint 取随凭据下发的租户端点（与 key 同源不变量）。拿不到
  // （未登录 / 无 server 标记 / 网关不可用）判后端不可用，由调用方走 fallback/回退。
  if (routing.authStrategy === 'gateway-key') {
    const dynamic = deps.resolveGatewayEndpoint?.() ?? null;
    if (!dynamic) {
      throw new VisionBackendError(
        'unavailable',
        `gateway endpoint unavailable for provider ${provider.id} (not signed in or no server endpoint)`,
      );
    }
    const headers = applyAuthStrategy(provider, agent, deps);
    return {
      upstream: dynamic.replace(/\/$/, ''),
      requestPath,
      model: rewriteVisionModel(modelId, routing.modelIdRewrite?.stripPrefix),
      authorization: headers.authorization ?? null,
      headers: visionRouteHeaders(routing),
      wireProtocol,
    };
  }
  const headers = applyAuthStrategy(provider, agent, deps);
  return {
    upstream: routing.upstream.replace(/\/$/, ''),
    requestPath,
    model: rewriteVisionModel(modelId, routing.modelIdRewrite?.stripPrefix),
    authorization: headers.authorization ?? null,
    headers: visionRouteHeaders(routing),
    wireProtocol,
  };
}
