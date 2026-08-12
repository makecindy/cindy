/**
 * Auto-review 请求的额度自适应。
 *
 * 背景:审核请求原本固定 384 token / 12 秒 / reasoningEffort='low'。这套参数
 * 对「能关掉思考」的模型足够,但对**强制思考**的模型是致命的 —— 它们的档位里
 * 根本没有 low/minimal,传了也会被上调,于是 384 token 全烧在思考上、正文为空,
 * 审核判定失败。实测(2026-08-11)DeepSeek V4 Pro 在部分灰区用例上三轮全部
 * `empty_content_reasoning_only`,而且越是需要斟酌的场景越容易触发 ——
 * 审核最该发挥作用的时刻恰好最容易失效。
 *
 * 参考 Codex Guardian 的取舍:它给审阅器的是 272k 窗口、无输出上限、medium 档,
 * 还允许调工具查证。我们不做到那个量级(那需要嵌套 agent 会话),但至少要让
 * 强制思考的模型有写完结论的空间 —— 慢一点可以接受,判不出来不行。
 */

import type { AgentKind, CatalogModel } from '@cindy/model-providers';

/** 能关思考的模型:够写一个 JSON 裁决即可。 */
const COMPACT_MAX_TOKENS = 384;
const COMPACT_TIMEOUT_MS = 12_000;

/**
 * 强制思考的模型:思考段 + 结论段都要装得下。
 *
 * 4096 是按实测的思考长度留的余量(DeepSeek 类模型在灰区用例上的思考通常
 * 1-2k token),不是拍脑袋的大数 —— 再大只会让超时更容易先触发。
 */
const REASONING_MAX_TOKENS = 4_096;

/**
 * 相应放宽的超时。思考模型多花的是**输出**时间,首 token 延迟差别不大,
 * 所以按输出量等比放宽而不是无限等 —— 用户仍在等这次工具调用。
 */
const REASONING_TIMEOUT_MS = 30_000;

/** 审核请求的执行参数。 */
export interface AutoReviewBudget {
  maxTokens: number;
  timeoutMs: number;
  /** `undefined` = 不传该字段,让模型走自己的默认档。 */
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';
}

/**
 * 该模型能否把思考关到最低档。
 *
 * 判据是模型目录声明的 `efforts`:
 *   - 含 `minimal` 或 `low` → 能关,给紧凑额度;
 *   - 明确非空但不含二者(如 DeepSeek 的 `['high','max']`)→ 强制思考,给宽裕额度;
 *   - 空数组 `[]` → 该模型不支持切档(如 Kimi K2.6),它也不会强制长思考,按紧凑处理;
 *   - `undefined`(目录里没这个模型 / 自定义供应商未声明)→ **保守按强制思考处理**。
 *     宁可多给额度慢一点,也不要重演 384 token 判不出来的静默失败。
 */
export function modelCanSuppressReasoning(model: CatalogModel | undefined): boolean {
  const efforts = model?.efforts;
  if (efforts === undefined) return false;
  if (efforts.length === 0) return true;
  return efforts.includes('minimal') || efforts.includes('low');
}

/**
 * 紧凑档实际该发的 effort:该模型**自己声明过**的最低档,没有声明就不发。
 *
 * 只在 `modelCanSuppressReasoning` 为真时调用,所以这里只需区分 low / minimal /
 * 空数组三种;`undefined`(目录查不到)走的是宽裕分支,压根到不了这里。
 */
function lowestDeclaredEffort(
  model: CatalogModel | undefined,
): 'minimal' | 'low' | undefined {
  const efforts = model?.efforts;
  if (!efforts || efforts.length === 0) return undefined;
  if (efforts.includes('low')) return 'low';
  if (efforts.includes('minimal')) return 'minimal';
  return undefined;
}

/**
 * 按模型能力选额度。
 *
 * `model` 传 `undefined` 表示目录里查不到 —— 走保守分支(宽裕额度)。
 */
export function resolveAutoReviewBudget(model: CatalogModel | undefined): AutoReviewBudget {
  if (modelCanSuppressReasoning(model)) {
    return {
      maxTokens: COMPACT_MAX_TOKENS,
      timeoutMs: COMPACT_TIMEOUT_MS,
      // 只发该模型真正声明的最低档 —— 紧凑分支覆盖三种模型,不能一律发 low:
      //   - 声明了 low        → low
      //   - 只声明 minimal    → minimal(如 z-ai/glm-5.2;发 low 会被上游拒绝或
      //                        悄悄提到更高档,反而烧掉 384 token 的正文空间)
      //   - efforts: []       → 省略(如 Haiku 4.5 / Kimi K2.6 / grok 系共 10 个;
      //                        它们根本没有档位概念,带一个不认的字段是白白冒 400 的险)
      // 发错档会让审阅请求连续失败 → 重试耗尽 → 每个灰区操作降级成用户确认,
      // 正好绕回本 PR 要修的故障(PR #2474 review P1)。
      reasoningEffort: lowestDeclaredEffort(model),
    };
  }
  return {
    maxTokens: REASONING_MAX_TOKENS,
    timeoutMs: REASONING_TIMEOUT_MS,
    // 强制思考的模型不传 effort:传 low 会被���调成它支持的最低档,平白让请求
    // 带一个不生效的字段;个别上游还会因为不认的值直接 400。
    reasoningEffort: undefined,
  };
}

/** 从当前目录里查一个 (供应商, agent, 模型) 的目录条目。 */
export function findCatalogModel(
  providers: ReadonlyArray<{
    id: string;
    models: Partial<Record<AgentKind, CatalogModel[]>>;
  }>,
  providerId: string | null | undefined,
  agentKind: AgentKind,
  modelId: string,
): CatalogModel | undefined {
  const normalizedModel = modelId.trim();
  if (!normalizedModel) return undefined;
  const normalizedProvider = providerId?.trim();
  if (normalizedProvider) {
    // 点名了供应商就**只**在它的目录里找:同一个模型 id 在不同供应商下可能声明不同
    // 的 efforts,跨家借用会把强制思考的路由误判成"能关思考",于是又拿回 384/12s 的
    // 紧凑额度 —— 正是本 PR 要修的那个空正文故障(PR #2474 review)。
    // 未命中返回 undefined,由调用方走保守宽裕档。
    const provider = providers.find((item) => item.id === normalizedProvider);
    return (provider?.models[agentKind] ?? []).find((m) => m.id === normalizedModel);
  }
  // 没有 providerId(Pi 的 null = 走默认网关路由)时按模型 id 全目录找第一个命中。
  // 只用于读能力元数据,不参与路由决策,所以首见即可。
  for (const provider of providers) {
    const hit = (provider.models[agentKind] ?? []).find((m) => m.id === normalizedModel);
    if (hit) return hit;
  }
  return undefined;
}
