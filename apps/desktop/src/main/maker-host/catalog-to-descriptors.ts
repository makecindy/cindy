/**
 * catalog-to-descriptors —— 把 @cindy/model-providers 目录派生成 maker-core 的 per-agent
 * availableModels（ModelDescriptor[]）。
 *
 * 背景：模型清单的 SSoT 已迁到目录（providers.json）。maker-core 不再写死 CLAUDE_MODELS /
 * CODEX_MODELS（其 capabilities.availableModels 起始为空），host 在 bootstrap 时从**同步的**
 * BUNDLED_CATALOG 派生每个 agent 的模型列表，经 capabilityAdditions 注入。
 *
 * union 规则：跳过 `routing[agent].disabled` 的 runtime，再按 `catalog.providers` 数组序
 * flatMap 各 provider 的 `models[agent]`，按 id **首见胜出**去重（provider 序即
 * anthropic → openai → xd）。禁用来源不占 seen，同 id 仍可由后续可用来源补上。
 *
 * 顺序契约（no-break）：派生结果必须逐字逐序复现迁移前的有效列表
 * （cc = 旧 CLAUDE_MODELS 序 then XD 追加序；codex = 旧 CODEX_MODELS 序 then 折扣追加序）。
 * 由 maker-host 的 catalogDerivedModels.test.ts 守。
 */

import type { Catalog, CatalogModel, AgentKind } from '@cindy/model-providers';
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
