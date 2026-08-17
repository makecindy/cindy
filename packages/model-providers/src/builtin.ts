/**
 * builtin.ts —— 内置供应商身份卡(TS 常量)+ bundled 目录组装。
 *
 * 2026-07-19 模型列表统一重构定案:**清单来源唯一化**——
 *   - anthropic:清单来自 Agent SDK(会话 init 捕获)+ 登录时 HTTP `/v1/models`,
 *     由 host 注入(active-catalog setAnthropicDiscoveredModels);本文件只有身份卡,零模型。
 *   - openai:清单来自 codex 模型注册表(models_cache.json,codex-model-discovery 派生),
 *     经 active-catalog 注入 codex 并投影 claude-code bridge;本文件零模型。
 *   - xd(Cindy AI 网关):清单来自 model-access-server GET /models(网关权威,
 *     元数据由服务端 modelRegistry 下发);本文件零模型。
 *   - xai:SuperGrok 订阅 OAuth 没有任何列模型通道(官方未提供),清单是唯一
 *     必须静态维护的——活在 `catalog/providers.json`(仓内正本 = OSS 发布物 = dev 直读),
 *     此处从 json 引入作 bundled 兜底。
 *
 * 身份卡(id / auth / access / routing / titleModel / 媒体模型清单)是随代码走的事实:
 * 改它们必然伴随发版(SDK 集成 / 翻译桥 / 网关协议都是代码),所以写死在这里,
 * 不再经 OSS 下发。OSS `cfg/providers.json`(v2)只承载 xai 清单 + presets 模板,
 * 模型元数据与参考价只走同目录下严格版本化的 `model-registry.json`。
 *
 * ⚠️ 顺序契约:BUILTIN_PROVIDERS 的数组序(anthropic → openai → xai → xd)决定
 * 选择器分段顺序与 deriveAvailableModels 的 first-wins 去重优先级,不要改动。
 */

import catalogJson from '../catalog/providers.json' with { type: 'json' };
import modelRegistryJson from '../catalog/model-registry.json' with { type: 'json' };

import type { ModelRegistry } from './modelAccessBean.js';
import type { Catalog, CatalogModel, Provider } from './types.js';

/** 仓内 v2 目录文件(xai 清单 + presets;同一文件发布到 OSS `cfg/providers.json`)。 */
const catalogFile = catalogJson as unknown as Catalog;
const bundledModelRegistry = modelRegistryJson as unknown as ModelRegistry;

/**
 * 把静态目录条目的上下文窗口标记为**已核实**(不 mutate 入参)。
 *
 * 静态目录 —— 仓内 `catalog/providers.json` 与同格式的远端下发目录 —— 里的
 * `contextWindow` 是产品侧逐条写定的真实上限,可以用来收敛运行期上报的窗口。动态发现
 * 的模型**不走这里**(它们经 `set*DiscoveredModels` 注入,各自表态;上游不给元数据时补的
 * 兜底常量一律不标记)。条目自己显式表过态时尊重原值。
 *
 * 语义见 `CatalogModel.contextWindowVerified`;不标记静态目录会让 xai 这类纯静态清单的
 * 真实窗口(如 256K 的 `xai/grok-code-fast`)被当成未核实,虚高的上报值就收敛不掉。
 */
export function withVerifiedStaticWindows(provider: Provider): Provider {
  const models: Provider['models'] = {};
  let changed = false;
  for (const [agent, list] of Object.entries(provider.models) as Array<
    [keyof Provider['models'], Provider['models'][keyof Provider['models']]]
  >) {
    if (!list) continue;
    models[agent] = list.map((m) => {
      if (m.contextWindowVerified !== undefined) return m;
      changed = true;
      return { ...m, contextWindowVerified: true };
    });
  }
  return changed ? { ...provider, models } : provider;
}

const xaiRaw = catalogFile.providers.find((p) => p.id === 'xai');
if (!xaiRaw) {
  // 仓内目录文件被误删 xai 段属于构建期错误,越早炸越好(import 期即失败)。
  throw new Error('[model-providers] catalog/providers.json missing builtin provider "xai"');
}
const xaiFromCatalog = withVerifiedStaticWindows(xaiRaw);
const withoutPiApi = (model: CatalogModel): CatalogModel => {
  if (model.piApi === undefined) return model;
  const rest = { ...model };
  delete rest.piApi;
  return rest;
};
const xaiClaudeModels = xaiFromCatalog.models['claude-code'] ?? [];
const xaiCodexModels = xaiFromCatalog.models.codex ?? [];

/** xAI 静态清单同时供 Claude bridge、Codex 与 Pi bridge 使用。 */
const XAI_PROVIDER: Provider = {
  ...xaiFromCatalog,
  agents: xaiFromCatalog.agents.includes('pi')
    ? xaiFromCatalog.agents
    : [...xaiFromCatalog.agents, 'pi'],
  routing: {
    ...xaiFromCatalog.routing,
    pi: xaiFromCatalog.routing.pi ?? xaiFromCatalog.routing['claude-code'],
  },
  models: {
    ...xaiFromCatalog.models,
    'claude-code': xaiClaudeModels.map(withoutPiApi),
    codex: xaiCodexModels.map(withoutPiApi),
    // providers.json 的 piApi 只属于 Pi；源文件仍与 xAI 静态根同表维护，
    // bundled 投影在这里拆开，避免协议注解污染 Claude/Codex 快照契约。
    pi: xaiFromCatalog.models.pi ?? xaiClaudeModels,
  },
};

/** Anthropic(Claude.ai 订阅 OAuth)。模型清单运行时动态注入,此处恒为空。 */
const ANTHROPIC_PROVIDER: Provider = {
  id: 'anthropic',
  name: 'Anthropic',
  source: 'builtin',
  // Claude.ai OAuth can be used by native Claude Code and by the Codex/Pi
  // Anthropic Messages bridges. The bridged runtimes receive a host-owned token.
  agents: ['claude-code', 'codex', 'pi'],
  auth: { method: 'oauth' },
  access: { kind: 'subscription', product: 'Claude.ai' },
  titleModel: 'claude-haiku-4-5',
  routing: {
    'claude-code': {
      upstream: 'https://api.anthropic.com',
      authStrategy: 'oauth-passthrough',
    },
    codex: {
      upstream: 'https://api.anthropic.com',
      wireProtocol: 'anthropic-messages',
      authStrategy: 'provider-oauth-header',
      headerOverride: {
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20',
      },
      headerDelete: ['chatgpt-account-id', 'openai-beta', 'originator', 'session_id'],
    },
    pi: {
      upstream: 'https://api.anthropic.com',
      authStrategy: 'provider-oauth-header',
      headerOverride: {
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'oauth-2025-04-20',
      },
      headerDelete: ['x-api-key'],
    },
  },
  models: { 'claude-code': [], codex: [], pi: [] },
};

/** OpenAI(ChatGPT 订阅 OAuth)。模型清单来自 codex 注册表,此处恒为空。 */
const OPENAI_PROVIDER: Provider = {
  id: 'openai',
  name: 'OpenAI',
  source: 'builtin',
  agents: ['codex', 'claude-code', 'pi'],
  auth: { method: 'oauth' },
  access: { kind: 'subscription', product: 'ChatGPT' },
  titleModel: 'gpt-5.4-mini',
  // 图像通道:已登录 ChatGPT/Codex 时走 Codex Responses 的 hosted
  // image_generation tool;用户另配 `openai-images` Platform key 时优先走 public
  // Images API。id 带 openai/ 前缀(跨供应商数据契约,防 first-wins 归属漂移);
  // 不声明 imageDefaults(xd 默认地位不动)。
  imageModels: [{ id: 'openai/gpt-image-2', name: 'GPT Image 2' }],
  routing: {
    codex: {
      upstream: 'https://chatgpt.com/backend-api/codex',
      authStrategy: 'oauth-passthrough',
    },
    'claude-code': {
      upstream: 'https://chatgpt.com/backend-api/codex',
      authStrategy: 'oauth-passthrough',
      modelPrefixes: ['chatgpt/'],
    },
    pi: {
      upstream: 'https://chatgpt.com/backend-api/codex',
      authStrategy: 'oauth-passthrough',
      modelPrefixes: ['chatgpt/'],
    },
  },
  models: { codex: [], 'claude-code': [], pi: [] },
};

/** XD / Cindy AI 网关(账号体系托管 key)。模型清单来自网关实时下发,此处恒为空。 */
const XD_PROVIDER: Provider = {
  id: 'xd',
  name: 'XD Gateway',
  source: 'builtin',
  agents: ['claude-code', 'codex', 'pi'],
  auth: { method: 'managed' },
  access: { kind: 'managed' },
  titleModel: 'gpt-5.4-mini',
  imageModels: [
    { id: 'gpt-image-2', name: 'GPT Image 2' },
    { id: 'gemini-3-pro-image', name: 'Gemini 3 Pro Image' },
    { id: 'gemini-3.1-flash-image', name: 'Gemini 3.1 Flash Image' },
  ],
  imageDefaults: {
    standard: 'gpt-image-2',
    draft: 'gemini-3.1-flash-image',
  },
  videoModels: [
    { id: 'seedance-fast', name: 'Seedance 快速' },
    { id: 'seedance-pro', name: 'Seedance Pro' },
    { id: 'bytedance/seedance-2.5', name: 'Seedance 2.5' },
    { id: 'happyhorse', name: 'HappyHorse 1.0' },
  ],
  // 2.5 刻意不接管 best:它只到 720p,而 seedance-pro 有 1080p —— 让 tier=best
  // 指向 2.5 会把"要 1080p"的单子从可用变成明拒。2.5 需显式点名。
  videoDefaults: {
    standard: 'seedance-fast',
    best: 'seedance-pro',
  },
  // 向量模型:id 必须与 @cindy/embedding-client 的 EmbeddingModelId 逐字一致
  // (执行侧按 id 查 catalog 拿 provider 做 input_type 值域翻译,对不上就翻译不了)。
  // 只列 2026-08-04 经网关实测确认可用的型号 + 同族高置信的 3-large。
  // voyage-context-4 经同一 OpenAI 形态端点支持:索引侧把 input 传二维数组
  // (客户端 embedDocuments,按文档分组),查询侧仍传一维。注意它的响应形状由
  // **型号**决定而不是请求维度 —— 两侧都返两层嵌套 data,解析走同一个 parser。
  embeddingModels: [
    { id: 'voyage/voyage-4', name: 'Voyage 4' },
    { id: 'voyage/voyage-4-large', name: 'Voyage 4 Large' },
    { id: 'voyage/voyage-context-4', name: 'Voyage Context 4' },
    { id: 'voyage/voyage-code-3', name: 'Voyage Code 3' },
    { id: 'text-embedding-3-small', name: 'OpenAI Embedding 3 Small' },
    { id: 'text-embedding-3-large', name: 'OpenAI Embedding 3 Large' },
    { id: 'gemini-embedding-2-preview', name: 'Gemini Embedding 2 (Preview)' },
  ],
  // standard 取 voyage-4:1024 维、32K 单条上限、中等价格,且是四个候选里唯一
  // 实测确定性的多语通用型号。preview 型号不作默认(catalog 注释同口径)。
  embeddingDefaults: {
    standard: 'voyage/voyage-4',
    draft: 'text-embedding-3-small',
    best: 'voyage/voyage-4-large',
  },
  // XD 网关真实推理入口运行时由 model-access server 随凭据成对下发
  // (见 main/model-access/effectiveEndpoint.ts;端点清单/静态值已退役)。
  // gateway-key 路由只换鉴权头、不 override upstream,故此处 upstream 不参与路由,
  // 仅为满足类型的占位(不写内部域名);品牌按 provider id 判定,不读此值。
  routing: {
    'claude-code': {
      upstream: 'https://xd-gateway.invalid',
      authStrategy: 'gateway-key',
    },
    codex: {
      upstream: 'https://xd-gateway.invalid/v1',
      authStrategy: 'gateway-key',
      modelIdRewrite: { stripPrefix: 'codex/' },
    },
    // pi 直连网关 anthropic-messages 面(与 claude-code 同可达面);upstream 同为占位。
    pi: {
      upstream: 'https://xd-gateway.invalid',
      authStrategy: 'gateway-key',
    },
  },
  models: { 'claude-code': [], codex: [], pi: [] },
};

/**
 * Google Gemini(API key,媒体-only,2026-07 图像多来源)。
 * 没有 Google OAuth(那是后续独立项目),连接方式是用户自己的 Gemini API key
 * (Google AI Studio);agents 为空 —— 图像模型不经 agent runtime,由主机图像
 * 通道(geminiImageClient)直调,不参与任何聊天路由。模型 id 带 `gemini/` 前缀
 * 且**不声明 imageDefaults**:xd 网关的出厂默认地位不动(数据契约测试锁定)。
 */
const GEMINI_PROVIDER: Provider = {
  id: 'gemini',
  name: 'Google Gemini',
  source: 'builtin',
  agents: [],
  auth: { method: 'apiKey' },
  access: { kind: 'api' },
  imageModels: [
    { id: 'gemini/gemini-3-pro-image', name: 'Gemini 3 Pro Image' },
    { id: 'gemini/gemini-3.1-flash-image', name: 'Gemini 3.1 Flash Image' },
  ],
  routing: {},
  models: {},
};

/** 内置供应商(顺序契约见文件头;gemini 追加在 xd 之后,聊天分段与 first-wins 契约零影响)。 */
export const BUILTIN_PROVIDERS: Provider[] = [
  ANTHROPIC_PROVIDER,
  OPENAI_PROVIDER,
  XAI_PROVIDER,
  XD_PROVIDER,
  GEMINI_PROVIDER,
];

/** 打包进 App 的内置目录(离线兜底 / 远端拉取失败时使用)。 */
export const BUNDLED_CATALOG: Catalog = {
  version: catalogFile.version,
  providers: BUILTIN_PROVIDERS,
  modelRegistry: bundledModelRegistry,
  ...(catalogFile.presets && catalogFile.presets.length > 0 ? { presets: catalogFile.presets } : {}),
};
