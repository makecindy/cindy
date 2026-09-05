/**
 * catalog-to-descriptors —— 把 @cindy/model-providers 目录派生成 maker-core 的 per-agent
 * availableModels（ModelDescriptor[]）。
 *
 * 背景：模型清单的 SSoT 已迁到目录（providers.json）。maker-core 不再写死 CLAUDE_MODELS /
 * CODEX_MODELS（其 capabilities.availableModels 起始为空），host 在 bootstrap 时从**同步的**
 * BUNDLED_CATALOG 派生每个 agent 的模型列表，经 capabilityAdditions 注入。
 *
 * union 规则：跳过 `routing[agent].disabled` 的 runtime，再按 `catalog.providers` 数组序
 * flatMap 各 provider 的 `models[agent]`，按新路由统一准入跳过非聊天、停用与 retired 模型
 * (issue #882 第 3 点:网关多返回的图像/视频/TTS/STT/实时/Embedding/压缩模型不进 Agent
 * availableModels,但仍在模型管理设置页可见——那边走完整 catalog,不走这个函数),按 id
 * **首见胜出**去重（provider 序即 anthropic → openai → xd）。不可选来源不占 seen，同 id
 * 仍可由后续可用来源补上。例外有两项：Pi 的同 id 冲突涉及 user provider 时，扁平能力没有
 * provider provenance，effort 必须收敛为各可选来源的交集；后见 XD 条目携带当前 agent 的
 * 区域默认标记时，把该标记并入首见 descriptor，避免跨 provider 去重吞掉服务端策略。
 *
 * 顺序契约（no-break）：派生结果必须逐字逐序复现迁移前的有效列表
 * （cc = 旧 CLAUDE_MODELS 序 then XD 追加序；codex = 旧 CODEX_MODELS 序 then 折扣追加序）。
 * 由 maker-host 的 catalogDerivedModels.test.ts 守。
 */

import {
  PI_REASONING_EFFORTS,
  isAgentSelectableModel,
  isModelSelectableForNewRoute,
  type Catalog,
  type CatalogModel,
  type AgentKind,
} from '@cindy/model-providers';
import type { ModelDescriptor } from '@cindy/maker-core';
import type { ModelCatalogOverrides } from './model-plane/localCatalogOverrides.js';

/** Maker 能力读取面的最小形状；保留数组引用以让已创建 Session 同步看到新目录。 */
interface ModelCapabilitiesTarget {
  getCapabilities(agent: AgentKind): { availableModels: ModelDescriptor[] };
}

interface DescriptorProjectionOptions {
  preserveExplicitPiEfforts?: boolean;
}

function isOfficialGrok46Id(modelId: string): boolean {
  return modelId === 'grok-4.6' || modelId.endsWith('/grok-4.6');
}

interface SeenModelProjection {
  index: number;
  includesUserProvider: boolean;
}

function hasValidPiReasoningCapabilities(m: CatalogModel): boolean {
  const efforts = m.reasoningEfforts;
  return (
    Array.isArray(efforts) &&
    efforts.length > 0 &&
    efforts.every((effort) => PI_REASONING_EFFORTS.includes(effort)) &&
    typeof m.reasoningDefaultEffort === 'string' &&
    efforts.includes(m.reasoningDefaultEffort)
  );
}

/** CatalogModel → ModelDescriptor。仅透传 ModelDescriptor 需要的字段；可选字段缺省时不写键。 */
function toDescriptor(
  m: CatalogModel,
  agent: AgentKind,
  options: DescriptorProjectionOptions = {},
): ModelDescriptor {
  // 缺少或格式错误的 Pi 能力字段继续走旧目录 minimal 兼容补档。合法独立 Pi 目录的
  // reasoningEfforts 与 BYOM 声明都是协议能力，不能额外公布 models.json 禁用的档位。
  const efforts =
    agent === 'pi' &&
    options.preserveExplicitPiEfforts !== true &&
    !hasValidPiReasoningCapabilities(m) &&
    m.efforts.length > 0 &&
    !m.efforts.includes('minimal')
      ? (['minimal', ...m.efforts] as const)
      : m.efforts;
  const d: ModelDescriptor = {
    id: m.id,
    displayName: m.name,
    contextWindow: m.contextWindow,
    efforts,
    defaultEffort: m.defaultEffort,
  };
  // 刻意**不**透传 contextWindowVerified:availableModels 是跨 provider 去重后的扁平表,
  // provider 归属已丢,按 id 回查可能命中另一条路由的元数据。窗口能否作为上限必须按会话
  // 实际路由解析 —— 见下方 resolveVerifiedContextWindow(provenance 只活在 host 侧,
  // 不进这份跨端 descriptor)。
  if (m.description !== undefined) d.description = m.description;
  if (m.effortDisplayNames !== undefined) d.effortDisplayNames = m.effortDisplayNames;
  if (m.supportsFastMode !== undefined) d.supportsFastMode = m.supportsFastMode;
  if (m.group !== undefined) d.group = m.group;
  if (m.sortOrder !== undefined) d.sortOrder = m.sortOrder;
  if (m.mode !== undefined) d.mode = m.mode;
  // 默认可见性要透传：渲染层的种子默认模型取「排序第一**且默认可见**」的那个，没有它就会
  // 把默认收起的 legacy 模型选成默认 —— 用户在选择器里根本看不到自己的默认模型。
  if (m.defaultEnabled !== undefined) d.defaultEnabled = m.defaultEnabled;
  // 新对话默认种子标记要透传：渲染层 getDefaultModelForVendor 据它优先选中被标记的模型。
  // v3 可携带 Pi 自己的标记；消费端按 Agent 严格解释，不跨 Agent 借用默认策略。
  if (m.newSessionDefault !== undefined) d.newSessionDefault = m.newSessionDefault;
  if (m.cost !== undefined) d.cost = m.cost;
  if (m.maxOutput !== undefined) d.maxOutputTokens = m.maxOutput;
  const supportsImageInput =
    m.supportsImageInput ??
    (m.modalities !== undefined ? m.modalities.input.includes('image') : undefined);
  if (supportsImageInput !== undefined) d.supportsImageInput = supportsImageInput;
  return d;
}

/**
 * Pi 的公开 availableModels 是按 id 拍平的旧协议，无法表达同 id 的 per-provider effort。
 * 一旦冲突涉及 BYOM，只能公布各条可选路由都支持的交集；其余展示/窗口字段继续首见胜出。
 * 内置来源之间仍由 catalog 一致性校验守住相同 effort，不改变其 legacy first-wins。
 */
function intersectPiEffortCapabilities(
  first: ModelDescriptor,
  next: ModelDescriptor,
): ModelDescriptor {
  const efforts = first.efforts.filter((effort) => next.efforts.includes(effort));
  let defaultEffort = first.defaultEffort;
  if (defaultEffort === null || !efforts.includes(defaultEffort)) {
    defaultEffort =
      next.defaultEffort !== null && efforts.includes(next.defaultEffort)
        ? next.defaultEffort
        : (efforts[0] ?? null);
  }
  return { ...first, efforts, defaultEffort };
}

/**
 * availableModels 按 id 拍平后仍要保留 XD 区域策略。展示/能力字段继续首见胜出；这里只把
 * 当前 agent 对应的默认标记并到首见 descriptor，不把其它 Agent 的默认策略跨投影进来。
 */
function mergeNewSessionDefaultMarker(
  first: ModelDescriptor,
  next: ModelDescriptor,
  agent: AgentKind,
): ModelDescriptor {
  const hasNewMarker =
    next.newSessionDefault?.includes(agent) === true &&
    first.newSessionDefault?.includes(agent) !== true;
  if (!hasNewMarker) return first;
  return {
    ...first,
    newSessionDefault: [...(first.newSessionDefault ?? []), agent],
  };
}

/** 派生 availableModels：字段按 id 首见胜出；另收敛 Pi BYOM effort 与 XD 区域默认标记。 */
export function deriveAvailableModels(catalog: Catalog, agent: AgentKind): ModelDescriptor[] {
  const seen = new Map<string, SeenModelProjection>();
  const out: ModelDescriptor[] = [];
  for (const provider of catalog.providers) {
    if (provider.routing[agent]?.disabled === true) continue;
    for (const m of provider.models[agent] ?? []) {
      // provider-aware 谓词:合并目录里 source:'user' 的自定义供应商显式配置的模型带
      // 未知 group,id 撞上能力启发式(如 flux-image-x)时不能被误杀(2026-07 review 第
      // 25 轮)。非聊天模型不占 seen,同 id 若被其它来源标为 chat 仍可补上。
      // availableModels 是旧 mobile / device-link 等消费方的新选择清单，不能依赖下游
      // 再理解 retired。运行中会话仍从持久化 model + 完整 catalog 解析实际路由。
      const userProvider = provider.source === 'user';
      if (!isModelSelectableForNewRoute(m, { userProvider })) continue;
      const descriptor = toDescriptor(m, agent, {
        preserveExplicitPiEfforts:
          userProvider ||
          provider.id === 'xd' ||
          (provider.id === 'xai' && isOfficialGrok46Id(m.id)),
      });
      const previous = seen.get(m.id);
      if (previous) {
        let merged = out[previous.index];
        if (agent === 'pi' && (previous.includesUserProvider || userProvider)) {
          merged = intersectPiEffortCapabilities(merged, descriptor);
          previous.includesUserProvider ||= userProvider;
        }
        // 只有鉴权后的 XD /models 会被 active-catalog 投影成区域默认；公共 Registry 与
        // user provider 均不能借同 id 碰撞改变默认策略。
        if (provider.id === 'xd') {
          merged = mergeNewSessionDefaultMarker(merged, descriptor, agent);
        }
        out[previous.index] = merged;
        continue;
      }
      seen.set(m.id, { index: out.length, includesUserProvider: userProvider });
      out.push(descriptor);
    }
  }
  return out;
}

/**
 * 解析 Pi 当前持久化选择所需的运行时描述符,不参与公开模型清单或新路由准入。
 * 只使用 Pi 自己目录中的实际来源实体(允许 disabled/retired 供续跑)。缺少 Pi 条目时
 * 不从 Registry/Codex/Claude 重建，避免其它 harness 的成员关系污染 Pi。
 * `cindy` 是内置 gateway 的复合路由：按内置 provider 顺序解析，明确排除同 id user/BYOM。
 */
export function resolvePiRuntimeModelDescriptor(
  catalog: Catalog,
  providerId: string | null | undefined,
  modelId: string,
  _options: { localOverrides?: ModelCatalogOverrides } = {},
): ModelDescriptor | null {
  const providers =
    providerId === 'cindy'
      ? catalog.providers.filter((provider) => provider.source !== 'user')
      : providerId
        ? catalog.providers.filter((provider) => provider.id === providerId)
        : catalog.providers;
  for (const provider of providers) {
    const model = (provider.models.pi ?? []).find((candidate) => candidate.id === modelId);
    if (model && isAgentSelectableModel(model, { userProvider: provider.source === 'user' })) {
      return toDescriptor(model, 'pi', {
        preserveExplicitPiEfforts:
          provider.source === 'user' ||
          provider.id === 'xd' ||
          (provider.id === 'xai' && isOfficialGrok46Id(model.id)),
      });
    }
  }

  return null;
}

/** `cindy` provider 始终代表 XD Gateway；其能力描述符不得继承当前订阅/BYOM。 */
export function resolvePiGatewayDescriptorProviderId(
  providerId: string | null | undefined,
): string {
  void providerId;
  return 'xd';
}

/**
 * 解析某条**具体路由**上该模型已核实的上下文窗口上限；没有则返回 null。
 *
 * 为什么不能按 id 查 `availableModels`：那是跨 provider union + 首见去重的扁平表，同一
 * model id 可以由多个 provider 提供（订阅直连发现的 `gpt-5.6-sol` 注入 `openai`、网关下发
 * 的同 id 落在 `xd`；自定义 provider 也可能与内置重名），去重后 provider 归属就丢了。用错
 * 路由的上限去收敛运行期上报值，比不收敛更糟。
 *
 * 所以收敛的取值交给 host —— 只有它同时持有完整目录与 provider 维度：
 * - 给了 `providerId`（会话实际路由）→ 只认该 provider 的条目。
 * - 没给（默认路由 / 解析不出）→ 要求全目录对该 id **无歧义**：恰好一个候选才用它。
 * - 候选未标记 `contextWindowVerified` → null（那是派生兜底值，只够展示，见该字段注释）。
 *
 * 返回 null 一律意味着「不收敛」，也就是改动前的行为（fail-safe）。
 */
export { resolveVerifiedContextWindow } from '../../shared/sessionContextWindow';

/**
 * 自定义供应商上用户显式填写的 contextWindow。
 *
 * 注入 thread/start|resume 的 `model_context_window` 与
 * `model_auto_compact_token_limit`(窗口的 95%)。Codex 还会按模型目录里的
 * `max_context_window` 夹紧该值；Desktop 为这类会话启动隔离 app-server，并给它
 * 注入从当前 Codex 二进制提取、只抬高对应模型上限的完整目录。
 * 只认 `source === 'user'` 且 `contextWindowExplicit` 的条目:
 *   - 官方 ChatGPT 订阅走 live catalog 的 1M,不要被这条覆盖;
 *   - 网关核实上限(如 372K)只用于 Cindy 进度条收敛,写进 Codex 会改变官方会话压缩时机。
 * 缺省 200K 展示兜底不算显式,不注入。
 */
export function resolveExplicitCustomContextWindow(
  catalog: Catalog,
  agent: AgentKind,
  providerId: string | null | undefined,
  modelId: string,
): number | null {
  const source = providerId?.trim();
  if (!source) return null;
  const provider = catalog.providers.find((entry) => entry.id === source);
  if (!provider || provider.source !== 'user') return null;
  if (provider.routing[agent]?.disabled === true) return null;
  const model = (provider.models[agent] ?? []).find((entry) => entry.id === modelId);
  if (!model || model.contextWindowExplicit !== true) return null;
  return model.contextWindow > 0 ? model.contextWindow : null;
}

/**
 * 目录运行时刷新后原地替换两个 agent 的模型能力。不能直接赋新数组：本地 Session 持有 agent
 * capabilities 引用，原地 splice 才能让 provider:list 与实际可发送模型在同一次广播前对齐。
 */
export function refreshCatalogDerivedModels(
  target: ModelCapabilitiesTarget,
  catalog: Catalog,
): void {
  for (const agent of ['claude-code', 'codex', 'pi'] as const) {
    let availableModels: ModelDescriptor[];
    try {
      availableModels = target.getCapabilities(agent).availableModels;
    } catch {
      // pi 是可选 agent(二进制缺失时不注册),getCapabilities 抛错则跳过。
      continue;
    }
    availableModels.splice(0, availableModels.length, ...deriveAvailableModels(catalog, agent));
  }
}
