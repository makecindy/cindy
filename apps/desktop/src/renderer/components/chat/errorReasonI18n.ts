import { GATEWAY_PROXY_TOKEN_INVALID_REASON } from '@cindy/maker-shared/error-redaction';
import {
  CLAUDE_GATEWAY_OPUS_PLAN_MISMATCH_REASON,
  CLAUDE_SUBSCRIPTION_OPUS_PLAN_MISMATCH_REASON,
} from '../../../shared/claudeGatewayError';
import { UPSTREAM_OVERLOAD_REASON } from '@/utils/overloadError';
import { UPSTREAM_STREAM_INTERRUPTED_REASON } from '@/utils/streamInterruptError';

/**
 * Stable maker-core error reason -> renderer i18n key.
 *
 * Both the live ErrorBanner and persisted ErrorMessageCard consume this
 * side-effect-free map so the same terminal reason cannot drift between the
 * active and historical views.
 */
export const ERROR_REASON_I18N_KEYS: Record<string, string> = {
  'empty-response': 'logic.errors.emptyResponse',
  'turn-failed': 'logic.errors.turnFailed',
  'silent-stop-exhausted': 'logic.errors.silentStopExhausted',
  tool_use_loop_detected: 'logic.errors.toolUseLoopDetected',
  'permission-tighten-interrupt-failed': 'logic.errors.permissionTightenInterruptFailed',
  'codex-auto-review-unavailable': 'logic.errors.codexAutoReviewUnavailable',
  'host-shell-command-blocked': 'logic.errors.hostShellCommandBlocked',
  upstream_response_idle_timeout: 'logic.errors.upstreamResponseIdleTimeout',
  codex_reconnect_stalled: 'logic.errors.upstreamResponseIdleTimeout',
  codex_history_oversized: 'logic.errors.codexHistoryOversized',
  // 压缩风暴分两条:有切模型证据的才点名切模型。共用一条会让没切过模型(或已切回)
  // 的用户看到「请切回原模型」这种无从执行的指令 —— 这里的文案会覆盖 maker-core
  // 合成的 message,所以 reason 选错等于用户唯一看到的那句话就是错的。
  codex_compaction_not_converging: 'logic.errors.codexCompactionNotConverging',
  codex_compaction_not_converging_model_switch:
    'logic.errors.codexCompactionNotConvergingModelSwitch',
  session_event_loop_crashed: 'logic.errors.turnFailed',
  turn_no_event_timeout: 'logic.errors.turnNoEventTimeout',
  'context-overflow': 'chat.errorBanner.contextOverflow',
  [UPSTREAM_OVERLOAD_REASON]: 'chat.errorBanner.overloadBusyNoRetry',
  [UPSTREAM_STREAM_INTERRUPTED_REASON]: 'chat.errorBanner.streamInterruptedNoRetry',
  [CLAUDE_GATEWAY_OPUS_PLAN_MISMATCH_REASON]: 'chat.errorBanner.claudeGatewayOpusPlanMismatch',
  [CLAUDE_SUBSCRIPTION_OPUS_PLAN_MISMATCH_REASON]:
    'chat.errorBanner.claudeSubscriptionOpusPlanMismatch',
  [GATEWAY_PROXY_TOKEN_INVALID_REASON]: 'chat.errorBanner.gatewayProxyTokenInvalidNoRetry',
};
