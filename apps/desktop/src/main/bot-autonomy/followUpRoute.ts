/**
 * 伙伴跟进时「换哪个模型」的建议(get_task_digest 的 suggested_route)。
 *
 * 伙伴照建议用 set_session_runtime 代主人换模型，没有用户确认，也不会先交接重建上下文，
 * 所以只在换过去确实有用、且换过去装得下时给建议；其余情况不给，由伙伴提醒主人。
 * 规则见 docs/product-rules/cindy-bots-runtime.md §6.3。
 */
import type { TaskDigestFailure } from '../mcp-integrations/taskDigest.js';
import { decideProviderGroupFailure } from '../provider-group/failurePolicy.js';
import {
  botModelRouteIndex,
  nextBotModelRoute,
  normalizeBotModelChain,
  type BotModelRoute,
} from '../../shared/botModelChain.js';
import { agentSwitchKeepsContextHeadroom } from '../../shared/modelSwitchAssessment.js';

export interface FollowUpRouteInput {
  /** 调用方伙伴的有效候选链。 */
  chain: unknown;
  current: Pick<BotModelRoute, 'harness' | 'model' | 'providerId'>;
  /** 出错的那次失败；sdkError / errorStatus / codexErrorInfo 来自运行时记下的本轮终态(摘要投影里没有)。 */
  failure: TaskDigestFailure & { sdkError?: string; errorStatus?: number; codexErrorInfo?: string };
  /** 这件任务已经试过的路线(runtime key)。 */
  visitedRoutes: readonly string[];
  /** SSH 远端任务不能跨 harness 切换(与候选链自动恢复同一口径)。 */
  sameHarnessOnly: boolean;
  /** 任务当前上下文用量(tokens);没有可信读数为 null(此时不推荐更小窗口)。 */
  contextTokens: number | null;
  /** 任务当前路线的上下文窗口;未知为 null。 */
  currentContextWindow: number | null;
  /** 候选路线核实过的上下文窗口;未知为 null。 */
  windowOf(route: BotModelRoute): number | null;
}

export function suggestFollowUpRoute(input: FollowUpRouteInput): BotModelRoute | null {
  // 换模型救不了的失败(工具循环、上下文超限、请求本身无效、内容被拒等)不给建议,
  // 与供应商组「换到哪台都一样就不换」同一判定；没有可判断的错误时也不猜。
  if (input.failure.phase === 'errored') {
    const decision = decideProviderGroupFailure(
      {
        message: input.failure.error ?? '',
        ...(input.failure.errorReason ? { reason: input.failure.errorReason } : {}),
        ...(input.failure.sdkError ? { sdkError: input.failure.sdkError } : {}),
        ...(typeof input.failure.errorStatus === 'number' ? { errorStatus: input.failure.errorStatus } : {}),
        ...(input.failure.codexErrorInfo ? { codexErrorInfo: input.failure.codexErrorInfo } : {}),
      },
      'run',
    );
    if (decision.action === 'stay') return null;
  }
  const chain = normalizeBotModelChain(input.chain);
  // 任务当前路线不在伙伴候选链里(主人自己选的模型)：伙伴的链不是这件任务的备选，不建议换。
  // 同一模型换了明确不同的供应商也算链外(候选链自动恢复用的宽松匹配在这里不适用)。
  const index = botModelRouteIndex(chain, input.current);
  if (index < 0) return null;
  const matched = chain[index]!.providerId;
  if (matched && input.current.providerId && matched !== input.current.providerId) return null;
  return nextBotModelRoute(
    chain,
    input.current,
    input.visitedRoutes,
    (candidate) =>
      (!input.sameHarnessOnly || candidate.harness === input.current.harness)
      // 换过去就挤满的小窗口路线不推荐。
      && agentSwitchKeepsContextHeadroom({
        contextTokens: input.contextTokens,
        currentContextWindow: input.currentContextWindow,
        targetContextWindow: input.windowOf(candidate),
      }),
  );
}

type UsageReading = { contextTokens: number; contextWindow: number } | null | undefined;

const positive = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;

/**
 * 跟进建议用的可信上下文用量。
 * - live:当前 runtime 的读数;刚 attach、usage 回流前是占位 0。
 * - closed:上一段 runtime 关闭那一刻固化的读数(关闭时也可能把占位 0 固化进去)。
 * - dbContextTokens:库里的用量,只在一轮正常收尾时落库,中断 / 崩溃后可能低报。
 *
 * 运行时读数(live 与 closed 取大)为 0 或缺失时一律按未知(contextTokens: null),
 * 建议层因此不推荐更小窗口;库值只作运行时读数的下限,不能单独证明缩窗安全。
 * 高估只会让更小窗口的候选落空，不会误缩窗。
 */
export function deriveFollowUpUsage(input: {
  live: UsageReading;
  closed: UsageReading;
  dbContextTokens: number | null | undefined;
}): { contextTokens: number | null; contextWindow: number | null } {
  const runtimeTokens = Math.max(positive(input.live?.contextTokens) ?? 0, positive(input.closed?.contextTokens) ?? 0);
  return {
    contextTokens: runtimeTokens > 0 ? Math.max(runtimeTokens, positive(input.dbContextTokens) ?? 0) : null,
    contextWindow: positive(input.live?.contextWindow) ?? positive(input.closed?.contextWindow),
  };
}
