import type { TFunction } from 'i18next';
import type { ReconnectHandoff } from '../../../shared/agentInputQueue';
import {
  GATEWAY_PROXY_TOKEN_INVALID_REASON,
  isProviderSafetyRefusalError,
  isRemoteCompactEncryptedContentError,
  PROVIDER_SAFETY_REFUSAL_REASON,
  REMOTE_COMPACT_ENCRYPTED_CONTENT_REASON,
} from '@cindy/maker-shared/error-redaction';
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
  user_model_access_denied: 'chat.errorBanner.modelAccessDenied',
  'empty-response': 'logic.errors.emptyResponse',
  'turn-failed': 'logic.errors.turnFailed',
  'silent-stop-exhausted': 'logic.errors.silentStopExhausted',
  'unexecuted-tool-markup': 'logic.errors.unexecutedToolMarkup',
  'yield-continuation-incomplete': 'logic.errors.executionResultUnavailable',
  'output-limit': 'logic.errors.outputLimit',
  tool_use_loop_detected: 'logic.errors.toolUseLoopDetected',
  'permission-tighten-interrupt-failed': 'logic.errors.permissionTightenInterruptFailed',
  'runtime-selection-cancelled': 'newChat.chatInput.switchFailed',
  'codex-auto-review-unavailable': 'logic.errors.codexAutoReviewUnavailable',
  'host-shell-command-blocked': 'logic.errors.hostShellCommandBlocked',
  upstream_response_idle_timeout: 'logic.errors.upstreamResponseIdleTimeout',
  bridge_upstream_response_idle_timeout: 'logic.errors.upstreamResponseIdleTimeout',
  codex_reconnect_stalled: 'logic.errors.codexReconnectStalled',
  codex_history_oversized: 'logic.errors.codexHistoryOversized',
  // Persisted error rows and the live reason both lack a reliable retirement
  // cause, so use copy that does not claim a location or authentication cause.
  'app-server-force-retired': 'chat.errorBanner.codexAppServerRetired',
  // 压缩风暴分两条:有切模型证据的才点名切模型。共用一条会让没切过模型(或已切回)
  // 的用户看到「请切回原模型」这种无从执行的指令 —— 这里的文案会覆盖 maker-core
  // 合成的 message,所以 reason 选错等于用户唯一看到的那句话就是错的。
  codex_compaction_not_converging: 'logic.errors.codexCompactionNotConverging',
  codex_compaction_not_converging_model_switch:
    'logic.errors.codexCompactionNotConvergingModelSwitch',
  session_event_loop_crashed: 'logic.errors.turnFailed',
  turn_no_event_timeout: 'logic.errors.turnNoEventTimeout',
  bridge_turn_no_event_timeout: 'logic.errors.turnNoEventTimeout',
  'context-overflow': 'chat.errorBanner.contextOverflow',
  [REMOTE_COMPACT_ENCRYPTED_CONTENT_REASON]: 'chat.errorBanner.remoteCompactEncryptedContent',
  [UPSTREAM_OVERLOAD_REASON]: 'chat.errorBanner.overloadBusyNoRetry',
  'UPSTREAM_OVERLOADED': 'chat.errorBanner.overloadBusyNoRetry',
  [UPSTREAM_STREAM_INTERRUPTED_REASON]: 'chat.errorBanner.streamInterruptedNoRetry',
  [CLAUDE_GATEWAY_OPUS_PLAN_MISMATCH_REASON]: 'chat.errorBanner.claudeGatewayOpusPlanMismatch',
  [CLAUDE_SUBSCRIPTION_OPUS_PLAN_MISMATCH_REASON]:
    'chat.errorBanner.claudeSubscriptionOpusPlanMismatch',
  [GATEWAY_PROXY_TOKEN_INVALID_REASON]: 'chat.errorBanner.gatewayProxyTokenInvalidNoRetry',
  [PROVIDER_SAFETY_REFUSAL_REASON]: 'chat.errorBanner.providerSafetyRefusal',
};

export function localizeReconnectStall(t: TFunction, handoff?: ReconnectHandoff): string {
  const summary = t('logic.errors.codexReconnectStalled');
  if (handoff === 'disabled') return `${summary} ${t('logic.errors.reconnectAutoResumeDisabled')}`;
  if (handoff === 'exhausted') return `${summary} ${t('logic.errors.reconnectAutoResumeExhausted')}`;
  return summary;
}

/** Also correct persisted failures from hosts that used the old overflow reason or lacked the safety reason. */
export function errorReasonI18nKey(reason: string | null | undefined, message: string): string | undefined {
  if (message.startsWith('provider-rejected-before-dispatch: [PI_RETRY_HISTORY_FRAME_TOO_LARGE] ')) {
    return 'chat.errorBanner.piRetryHistoryTooLarge';
  }
  if (message.startsWith('provider-rejected-before-dispatch: Provider rejected the Session send before dispatch: ')) {
    return 'chat.errorBanner.messageNotSent';
  }
  if ((!reason || reason === 'context-overflow') && isRemoteCompactEncryptedContentError(message, reason)) {
    return 'chat.errorBanner.remoteCompactEncryptedContent';
  }
  if (isProviderSafetyRefusalError(message, reason)) {
    return 'chat.errorBanner.providerSafetyRefusal';
  }
  return reason ? ERROR_REASON_I18N_KEYS[reason] : undefined;
}
