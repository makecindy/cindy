/**
 * catalog-to-descriptors —— 把 @cindy/model-providers 目录派生成 maker-core 的 per-agent
 * availableModels（ModelDescriptor[]）。
 *
 * 背景：模型清单的 SSoT 已迁到目录（providers.json）。maker-core 不再写死 CLAUDE_MODELS /
 * CODEX_MODELS（其 capabilities.availableModels 起始为空），host 在 bootstrap 时从**同步的**
 * BUNDLED_CATALOG 派生每个 agent 的模型列表，经 capabilityAdditions 注入。
 *
 * union 规则：跳过 `routing[agent].disabled` 的 runtime，再按 `catalog.providers` 数组序
 * flatMap 各 provider 的 `models[agent]`，跳过非聊天模型(isAgentSelectableModel,issue #882 第 3 点:
 * 网关多返回的图像/视频/TTS/STT/实时/Embedding/压缩模型不进 Agent availableModels,但仍在
 * 模型管理设置页可见——那边走完整 catalog,不走这个函数),按 id **首见胜出**去重（provider 序即
 * anthropic → openai → xd）。禁用来源不占 seen，同 id 仍可由后续可用来源补上。
 *
 * 顺序契约（no-break）：派生结果必须逐字逐序复现迁移前的有效列表
 * （cc = 旧 CLAUDE_MODELS 序 then XD 追加序；codex = 旧 CODEX_MODELS 序 then 折扣追加序）。
 * 由 maker-host 的 catalogDerivedModels.test.ts 守。
 */

import { isAgentSelectableModel, type Catalog, type CatalogModel, type AgentKind } from '@cindy/model-providers';
import type { ModelDescriptor } from '@cindy/maker-core';

/** Maker 能力读取面的最小形状；保留数组引用以让已创建 Session 同步看到新目录。 */
interface ModelCapabilitiesTarget {
  getCapabilities(agent: AgentKind): { availableModels: ModelDescriptor[] };
}

/** CatalogModel → ModelDescriptor。仅透传 ModelDescriptor 需要的字段；可选字段缺省时不写键。 */
function toDescriptor(m: CatalogModel): ModelDescriptor {
  const d: ModelDescriptor = {
    id: m.id,
    displayName: m.name,
    contextWindow: m.contextWindow,
    efforts: m.efforts,
    defaultEffort: m.defaultEffort,
  };
  if (m.description !== undefined) d.description = m.description;
  if (m.effortDisplayNames !== undefined) d.effortDisplayNames = m.effortDisplayNames;
  if (m.supportsFastMode !== undefined) d.supportsFastMode = m.supportsFastMode;
  if (m.group !== undefined) d.group = m.group;
  if (m.sortOrder !== undefined) d.sortOrder = m.sortOrder;
  if (m.mode !== undefined) d.mode = m.mode;
  // 默认可见性要透传：渲染层的种子默认模型取「排序第一**且默认可见**」的那个，没有它就会
  // 把默认收起的 legacy 模型选成默认 —— 用户在选择器里根本看不到自己的默认模型。
  if (m.defaultEnabled !== undefined) d.defaultEnabled = m.defaultEnabled;
  return d;
}

/** 派生某 agent 的 availableModels：跨 provider union（数组序）+ 按 id 首见去重。 */
export function deriveAvailableModels(catalog: Catalog, agent: AgentKind): ModelDescriptor[] {
  const seen = new Set<string>();
  const out: ModelDescriptor[] = [];
  for (const provider of catalog.providers) {
    if (provider.routing[agent]?.disabled === true) continue;
    for (const m of provider.models[agent] ?? []) {
      if (seen.has(m.id)) continue;
      // provider-aware 谓词:合并目录里 source:'user' 的自定义供应商显式配置的模型带
      // 未知 group,id 撞上能力启发式(如 flux-image-x)时不能被误杀(2026-07 review 第
      // 25 轮)。非聊天模型不占 seen,同 id 若被其它来源标为 chat 仍可补上。
      if (!isAgentSelectableModel(m, { userProvider: provider.source === 'user' })) continue;
      seen.add(m.id);
      out.push(toDescriptor(m));
    }
  }
  return out;
}

/**
 * 目录运行时刷新后原地替换两个 agent 的模型能力。不能直接赋新数组：本地 Session 持有 agent
 * capabilities 引用，原地 splice 才能让 provider:list 与实际可发送模型在同一次广播前对齐。
 */
export function refreshCatalogDerivedModels(
  target: ModelCapabilitiesTarget,
  catalog: Catalog,
): void {
  for (const agent of ['claude-code', 'codex'] as const) {
    const availableModels = target.getCapabilities(agent).availableModels;
    availableModels.splice(0, availableModels.length, ...deriveAvailableModels(catalog, agent));
  }
}
