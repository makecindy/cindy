/**
 * vendorModelFallback —— 判定一个会话的 model 是否与它(固定不变的)agent vendor 错配、
 * 需要回退到该 vendor 的默认模型。CCAgentSessionView 的「M35 vendor fallback」effect 用它。
 *
 * 背景(为什么不直接用 maker-core 冻结快照判):
 *   渲染层有两套「模型真源」——
 *     1) live provider 目录(useProviders → getActiveCatalog):**按 agent 维度**列模型,含自定义供应商;
 *     2) maker-core capabilities.availableModels:agent 构造时一次性派生的**冻结快照**,把 cc/codex
 *        压平后 first-wins 去重,且自定义供应商(DB ready 后才注入目录)从不进这张表。
 *   旧逻辑(getModelsForVendor / getModelById)走第 2 套,导致两类误判:
 *     - `gpt-5.4` 这类两端同名 id:压平后被 cc 抢走 → 在 codex 会话里被当成跨 vendor;
 *     - 自定义(mimo 等)codex 模型:冻结表里压根没有 → 被当成非法 → reset 成 gpt。
 *   本判定改走第 1 套(live + 按 agent),与模型选择器同源,从根上消除这两类误判。
 *
 * 判定语义(保守):**只有当 model 明确属于"另一个 vendor"时才回退** —— 即对端 agent 的供应商
 * offer 它、而本端任何供应商都不 offer。这是 vendor↔model 错配的唯一确定信号。其余情况一律不动:
 *   - 本端 offer(内置 / gpt-5.x / 自定义)→ 合法,不回退;
 *   - 两端都不认识的 id(legacy 别名如 `gpt-5-codex`、上古脏数据、或目录尚未加载完成的瞬间)
 *     → 保守不动,交给 spawn 层透传(与 cc 历史行为一致),避免目录 load race 误杀用户选的模型。
 */

import { providerOffersModel, type AgentKind, type ProviderView } from '@cindy/model-providers';

/**
 * 该会话 model 是否需要回退到 vendor 默认。
 *
 * @param providers   live 供应商视图(useProviders 的结果;含内置 + 自定义,按 agent 挂模型)。
 * @param sessionModel 会话当前存的 model id。
 * @param agent        会话所属 agent(建会话即固定,不可变)。
 * @returns true = 需要回退(model 明确属于另一个 vendor);false = 保持不动。
 */
export function shouldFallbackVendorModel(
  providers: ProviderView[],
  sessionModel: string,
  agent: AgentKind,
): boolean {
  // 本端任一供应商 offer 该模型 → 合法(含自定义供应商、gpt-5.x 等),绝不回退。
  if (providers.some((p) => providerOffersModel(p, sessionModel, agent))) return false;
  // 本端不 offer:仅当对端 agent 明确 offer 它(确定的跨 vendor 错配)才回退;
  // 两端都不认识(别名 / 脏数据 / 目录未加载)→ 不动,避免误杀。
  const other: AgentKind = agent === 'codex' ? 'claude-code' : 'codex';
  return providers.some((p) => providerOffersModel(p, sessionModel, other));
}
