import { isResponsesLiteParallelToolCallsError, parseAgentErrorCode, isRemoteCompactEncryptedContentError } from '@cindy/maker-shared/error-redaction';
import { requiresAgentErrorConfigurationChange as requiresConfigurationChange } from '@cindy/maker-shared/error-redaction';
import { i18n } from '@/i18n';
import { describeAgentAuthError } from '@/device-link/remoteStatus';

export function requiresAgentErrorConfigurationChange(message: string): boolean {
  return message.includes('[REMOTE_AGENT_MEMBER_BUDGET_PAUSED]') || requiresConfigurationChange(message);
}

/**
 * Mobile history errors and recovery-less live failures share this guidance.
 * Retrying cannot fix missing host credentials, a lost Codex thread or content
 * encrypted for a different provider. Desktop has additional local-context gates.
 */
export function describeNonRetryableAgentError(text: string, reason?: unknown): string | null {
  if (text.includes('[REMOTE_AGENT_MEMBER_BUDGET_PAUSED]')) return i18n.t('session.remoteError.REMOTE_AGENT_MEMBER_BUDGET_PAUSED');
  const authGuidance = describeAgentAuthError(text);
  if (authGuidance) return authGuidance;
  if (/thread not found/i.test(text)) return i18n.t('session.tail.codexThreadLost');
  if (isRemoteCompactEncryptedContentError(text, reason)) return null;
  if (/invalid_encrypted_content/i.test(text)) return i18n.t('session.tail.encryptedContentInvalid');
  return null;
}

export type MobileToolLoopErrorKind = 'consecutive' | 'pingpong' | 'rotation' | 'contract';

export interface MobileToolLoopErrorDetails {
  kind: MobileToolLoopErrorKind;
  count: number;
}

const TOOL_LOOP_I18N_KEYS: Record<MobileToolLoopErrorKind, string> = {
  consecutive: 'session.tail.toolUseLoopDetectedConsecutiveWithCount',
  pingpong: 'session.tail.toolUseLoopDetectedPingPongWithCount',
  rotation: 'session.tail.toolUseLoopDetectedRotationWithCount',
  contract: 'session.tail.toolUseLoopDetectedWithCount',
};

/**
 * Parse the bounded details emitted by maker-core before using the count in UI
 * interpolation. Older rows may omit the details, so callers can still use
 * the generic reason-based copy.
 */
export function parseMobileToolLoopErrorDetails(value: unknown): MobileToolLoopErrorDetails | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as { kind?: unknown; count?: unknown };
  if (
    raw.kind !== 'consecutive' &&
    raw.kind !== 'pingpong' &&
    raw.kind !== 'rotation' &&
    raw.kind !== 'contract'
  ) {
    return null;
  }
  if (
    typeof raw.count !== 'number' ||
    !Number.isSafeInteger(raw.count) ||
    raw.count < 1 ||
    raw.count > 100_000
  ) {
    return null;
  }
  return { kind: raw.kind, count: raw.count };
}

/**
 * Localize stable agent error reasons for both the normal message stream and
 * the session-tail banner. Returning null keeps unrelated error rows on their
 * existing auth-guidance/raw-message paths.
 */
export function localizeAgentError(
  reason: unknown,
  toolLoop: MobileToolLoopErrorDetails | null,
  message = '',
): string | null {
  if (isRemoteCompactEncryptedContentError(message, reason)) return i18n.t('session.tail.remoteCompactEncryptedContent');
  if (reason === 'yield-continuation-incomplete') return i18n.t('session.tail.executionResultUnavailable');
  if (reason === 'output-limit') return i18n.t('session.tail.outputLimit');
  if (reason !== 'tool_use_loop_detected') return null;
  if (!toolLoop) return i18n.t('session.tail.toolUseLoopDetected');
  return i18n.t(TOOL_LOOP_I18N_KEYS[toolLoop.kind], { count: toolLoop.count });
}

/**
 * Personal WeChat cannot use Full access, so the shared outage key must not
 * suggest that mode when the task being viewed came from WeChat.
 */
export function autoReviewUnavailableGuidanceCode(sessionSource: unknown): string {
  return sessionSource === 'wechat'
    ? 'AUTO_REVIEW_UNAVAILABLE_WECHAT'
    : 'AUTO_REVIEW_UNAVAILABLE';
}

/** Unknown provider messages stay in diagnostic details, never in the localized summary. */
export function unclassifiedAgentErrorI18nKey(message: string, sessionSource?: unknown): string {
  if (message.includes('[REMOTE_AGENT_MEMBER_BUDGET_PAUSED]')) return 'session.remoteError.REMOTE_AGENT_MEMBER_BUDGET_PAUSED';
  const limitReason = /\[REMOTE_AGENT_BUSY\] \[(DEVICE_LIMIT|TOTAL_LIMIT)\]/.exec(message)?.[1];
  if (limitReason) return `session.remoteError.REMOTE_AGENT_${limitReason}`;
  const parsed = parseAgentErrorCode(message);
  const code = parsed?.code === 'AUTO_REVIEW_UNAVAILABLE'
    ? autoReviewUnavailableGuidanceCode(sessionSource)
    : parsed?.code;
  const key = code ? `session.remoteError.${code}` : null;
  if (key && i18n.exists(key)) return key;
  return isResponsesLiteParallelToolCallsError(message)
    ? 'session.tail.requestFormatError'
    : 'session.tail.replyFailed';
}

/**
 * Copy for a recognized remote / runtime code in a one-shot action error (fork and the like).
 * Unknown codes return null so the caller keeps its own fallback instead of "reply failed".
 */
export function remoteActionErrorI18nKey(message: string): string | null {
  if (message.includes('[REMOTE_AGENT_MEMBER_BUDGET_PAUSED]')) return 'session.remoteError.REMOTE_AGENT_MEMBER_BUDGET_PAUSED';
  const code = parseAgentErrorCode(message)?.code;
  const key = code ? `session.remoteError.${code}` : null;
  return key && i18n.exists(key) ? key : null;
}

export function localizeUnclassifiedAgentError(message: string, sessionSource?: unknown): string {
  return i18n.t(unclassifiedAgentErrorI18nKey(message, sessionSource));
}
