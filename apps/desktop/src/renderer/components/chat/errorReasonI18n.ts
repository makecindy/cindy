import { CLAUDE_GATEWAY_OPUS_PLAN_MISMATCH_REASON } from '../../../shared/claudeGatewayError';
import { CONTEXT_OVERFLOW_REASON } from '@/utils/contextOverflowError';
import { UPSTREAM_OVERLOAD_REASON } from '@/utils/overloadError';

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
  'permission-tighten-interrupt-failed': 'logic.errors.permissionTightenInterruptFailed',
  'codex-auto-review-unavailable': 'logic.errors.codexAutoReviewUnavailable',
  upstream_response_idle_timeout: 'logic.errors.upstreamResponseIdleTimeout',
  codex_reconnect_stalled: 'logic.errors.upstreamResponseIdleTimeout',
  session_event_loop_crashed: 'logic.errors.turnFailed',
  turn_no_event_timeout: 'logic.errors.turnNoEventTimeout',
  [UPSTREAM_OVERLOAD_REASON]: 'chat.errorBanner.overloadBusyNoRetry',
  // 历史静态卡没有恢复按钮，使用明确的新建任务引导；live / tail 横幅仍由
  // ErrorBanner 根据可用 callback 选择压缩或新建任务文案。
  [CONTEXT_OVERFLOW_REASON]: 'chat.errorBanner.contextOverflowNoCompact',
  [CLAUDE_GATEWAY_OPUS_PLAN_MISMATCH_REASON]: 'chat.errorBanner.claudeGatewayOpusPlanMismatch',
};
