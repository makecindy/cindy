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
 * Localize the stable tool-loop reason for both the normal message stream and
 * the session-tail banner. Returning null keeps unrelated error rows on their
 * existing auth-guidance/raw-message paths.
 */
export function localizeToolLoopError(
  reason: unknown,
  toolLoop: MobileToolLoopErrorDetails | null,
): string | null {
  if (reason !== 'tool_use_loop_detected') return null;
  if (!toolLoop) return i18n.t('session.tail.toolUseLoopDetected');
  return i18n.t(TOOL_LOOP_I18N_KEYS[toolLoop.kind], { count: toolLoop.count });
}
