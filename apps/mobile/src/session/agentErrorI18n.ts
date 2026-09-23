import { isResponsesLiteParallelToolCallsError, parseAgentErrorCode } from '@cindy/maker-shared/error-redaction';
import { i18n } from '@/i18n';

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
): string | null {
  if (reason === 'yield-continuation-incomplete') return i18n.t('session.tail.executionResultUnavailable');
  if (reason === 'output-limit') return i18n.t('session.tail.outputLimit');
  if (reason !== 'tool_use_loop_detected') return null;
  if (!toolLoop) return i18n.t('session.tail.toolUseLoopDetected');
  return i18n.t(TOOL_LOOP_I18N_KEYS[toolLoop.kind], { count: toolLoop.count });
}

/** Unknown provider messages stay in diagnostic details, never in the localized summary. */
export function unclassifiedAgentErrorI18nKey(message: string): string {
  const parsed = parseAgentErrorCode(message);
  const key = parsed ? `session.remoteError.${parsed.code}` : null;
  if (key && i18n.exists(key)) return key;
  return isResponsesLiteParallelToolCallsError(message)
    ? 'session.tail.requestFormatError'
    : 'session.tail.replyFailed';
}

export function localizeUnclassifiedAgentError(message: string): string {
  return i18n.t(unclassifiedAgentErrorI18nKey(message));
}

/** Resending unchanged content cannot fix these explicit configuration failures. */
export function requiresAgentErrorConfigurationChange(message: string): boolean {
  const code = parseAgentErrorCode(message)?.code;
  return code === 'REMOTE_LOCAL_ATTACHMENT_UNSUPPORTED'
    || code === 'REMOTE_COMPAT_MODE_UNSUPPORTED'
    || code === 'REMOTE_LOCAL_ONLY_PROVIDER'
    || code === 'DEVICE_LINK_CONTROL_DISABLED';
}
