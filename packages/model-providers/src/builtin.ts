/**
 * builtin.ts —— 内置供应商身份卡(TS 常量)+ bundled 目录组装。
 *
 * 2026-07-19 模型列表统一重构定案:**清单来源唯一化**——
 *   - anthropic:清单来自 Agent SDK(会话 init 捕获)+ 登录时 HTTP `/v1/models`,
 *     由 host 注入(active-catalog setAnthropicDiscoveredModels);本文件只有身份卡,零模型。
 *   - openai:清单来自 codex 模型注册表(models_cache.json,codex-model-discovery 派生),
 *     经 active-catalog 注入 codex 并投影 claude-code bridge;本文件零模型。
 *   - xd(Cindy AI 网关):清单来自 model-access-server GET /models(网关权威,
 *     元数据由服务端 MODEL_METADATA 表下发);本文件零模型。
 *   - xai:SuperGrok 订阅 OAuth 没有任何列模型通道(官方未提供),清单是唯一
 *     必须静态维护的——活在 `catalog/providers.json`(仓内正本 = OSS 发布物 = dev 直读),
 *     此处从 json 引入作 bundled 兜底。
 *
 * 身份卡(id / auth / access / routing / titleModel / 媒体模型清单)是随代码走的事实:
 * 改它们必然伴随发版(SDK 集成 / 翻译桥 / 网关协议都是代码),所以写死在这里,
 * 不再经 OSS 下发。OSS `cfg/providers.json`(v2)只承载 xai 清单 + presets 模板,
 * 外加服务端消费的 `cindyModelMeta` 段(model-access-server 的网关模型元数据
 * 远程覆盖表,经 MODEL_METADATA_URL 指向同一文件热加载;客户端仅 dev 模式
 * 用它本地覆盖 XD 模型元数据以便自测,packaged 不读)。
 *
 * ⚠️ 顺序契约:BUILTIN_PROVIDERS 的数组序(anthropic → openai → xai → xd)决定
 * 选择器分段顺序与 deriveAvailableModels 的 first-wins 去重优先级,不要改动。
 */

import catalogJson from '../catalog/providers.json' with { type: 'json' };

import type { Catalog, Provider } from './types.js';

/** 仓内 v2 目录文件(xai 清单 + presets;同一文件发布到 OSS `cfg/providers.json`)。 */
const catalogFile = catalogJson as unknown as Catalog;

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

/** Anthropic(Claude.ai 订阅 OAuth)。模型清单运行时动态注入,此处恒为空。 */
const ANTHROPIC_PROVIDER: Provider = {
  id: 'anthropic',
  name: 'Anthropic',
  source: 'builtin',
  agents: ['claude-code'],
  auth: { method: 'oauth' },
  access: { kind: 'subscription', product: 'Claude.ai' },
  titleModel: 'claude-haiku-4-5',
  routing: {
    'claude-code': {
      upstream: 'https://api.anthropic.com',
      authStrategy: 'oauth-passthrough',
    },
  },
  models: { 'claude-code': [] },
};

/** OpenAI(ChatGPT 订阅 OAuth)。模型清单来自 codex 注册表,此处恒为空。 */
const OPENAI_PROVIDER: Provider = {
  id: 'openai',
  name: 'OpenAI',
  source: 'builtin',
  agents: ['codex', 'claude-code'],
  auth: { method: 'oauth' },
  access: { kind: 'subscription', product: 'ChatGPT' },
  titleModel: 'gpt-5.4-mini',
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
  },
  models: { codex: [], 'claude-code': [] },
};

/** XD / Cindy AI 网关(账号体系托管 key)。模型清单来自网关实时下发,此处恒为空。 */
const XD_PROVIDER: Provider = {
  id: 'xd',
  name: 'XD Gateway',
  source: 'builtin',
  agents: ['claude-code', 'codex'],
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
    { id: 'happyhorse', name: 'HappyHorse 1.0' },
  ],
  videoDefaults: {
    standard: 'seedance-fast',
    best: 'seedance-pro',
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
    },
  },
  models: { 'claude-code': [], codex: [] },
};

/** 内置供应商(顺序契约见文件头)。 */
export const BUILTIN_PROVIDERS: Provider[] = [
  ANTHROPIC_PROVIDER,
  OPENAI_PROVIDER,
  xaiFromCatalog,
  XD_PROVIDER,
];

/** 打包进 App 的内置目录(离线兜底 / 远端拉取失败时使用)。 */
export const BUNDLED_CATALOG: Catalog = {
  version: catalogFile.version,
  providers: BUILTIN_PROVIDERS,
  ...(catalogFile.presets && catalogFile.presets.length > 0 ? { presets: catalogFile.presets } : {}),
  // cindyModelMeta 随目录透传(消费点见 types.ts:服务端 + 客户端展示元数据基线)。
  ...(catalogFile.cindyModelMeta !== undefined ? { cindyModelMeta: catalogFile.cindyModelMeta } : {}),
};
