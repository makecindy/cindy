import type { AgentKind } from './types';

export interface UtilityTextDispatchRoute {
  providerId: string;
  agentKind: AgentKind;
  model: string;
}

export type UtilityTextRequestOptions = {
  maxTokens?: number;
  timeoutMs?: number;
  /** Optional lightweight reasoning hint for short internal classifiers. */
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';
  /**
   * Use the least thinking the model allows, for strict short-output budgets.
   * Messages and chat routes first try turning thinking off; Responses routes
   * start at the lowest catalog effort because that protocol has no off value.
   * See utilityReasoningPlan.ts for the fallback rules.
   */
  disableReasoning?: boolean;
  /** Abort an in-flight direct HTTP request when the owning workflow ends. */
  signal?: AbortSignal;
  /** Provider-native system/instructions text, kept separate from reference data. */
  systemPrompt?: string;
  onText?: (text: string) => void;
  /** Additional output-shape instruction (mainly for Responses-compatible routes). */
  responseInstructions?: string;
  /** Reject unusable output before selecting a winner, so the configured chain can continue. */
  validateResponse?: (text: string) => boolean;
  /** Final ownership/config guard immediately before an explicit HTTP dispatch. */
  beforeDispatch?: (route: UtilityTextDispatchRoute) => Promise<boolean>;
  /** 显式任务来源；存在时禁止跨来源 fallback。 */
  providerId?: string;
  agentKind?: AgentKind;
  model?: string;
  /**
   * 钉住某一个轻量档位(UTILITY_MODEL_PROFILES 的 key,如 codex-gpt-5.4-nano)。
   * 用于插件把 cindy.text.oneshot 的选型钉到一组供应商×模型上——与图像/视频
   * 的"钉后端"同一口径:**钉了就只用它**,不再沿链回落,否则"我钉了 A 却悄悄
   * 用了 B"比直接失败更伤信任。不认的值忽略(回到跟随默认)。
   */
  pinnedProfileId?: string;
};

