import type { SessionSendResult } from '@cindy/maker-core';
import {
  assertSendDispatched,
  toSessionDispatchOutcome,
  type SessionDispatchOutcome,
} from '@cindy/maker-core';

import { createLogger } from '../logger.js';

const log = createLogger('maker-send-outcome');

export const HOST_SEND_FAILURE_CODES = [
  'WORKDIR_MISSING',
  'LAZY_CREATE_FAILED',
  'REHYDRATE_FAILED',
  'SESSION_NOT_FOUND',
  'HOST_NOT_READY',
  'SESSION_RUNNING',
  /**
   * 共享 codex 进程要切凭证形态,但有其它本地 Codex 会话在忙。
   * 与 SESSION_RUNNING 分开:后者是本会话的 µs 级竞态,协调器静默退回队首重试即可;
   * 前者可能要等别的会话跑完几十分钟,静默重试=用户看到"永远排队"(2026-07-03 实报),
   * 必须走可见错误 + Retry。
   */
  'CREDENTIAL_SWITCH_BUSY',
  'SEND_FAILED',
] as const;

export type HostSendFailureCode = (typeof HOST_SEND_FAILURE_CODES)[number];

export type HostSendOutcome = {
  kind: 'host-send';
  accepted: false;
  code: HostSendFailureCode;
  message: string;
  /** CREDENTIAL_SWITCH_BUSY 专用:挡路的本地会话 ids(coordinator 用于事件驱动唤醒 + renderer 展示)。 */
  busySessionIds?: string[];
};

export type DesktopSessionDispatchSuccess = {
  kind: 'session-dispatch';
  source: string;
  dispatched: true;
};

export type DesktopSessionDispatchFailure = {
  kind: 'session-dispatch';
  source: string;
} & Extract<SessionDispatchOutcome, { dispatched: false }>;

export type DesktopSessionDispatchOutcome =
  | DesktopSessionDispatchSuccess
  | DesktopSessionDispatchFailure;

export type DesktopSendOutcome = HostSendOutcome | DesktopSessionDispatchOutcome;

export type DesktopMakerSendResult =
  | { accepted: true; outcome: DesktopSessionDispatchSuccess }
  | { accepted: false; reason: HostSendFailureCode; outcome: HostSendOutcome }
  | {
      accepted: false;
      reason: DesktopSessionDispatchFailure['reason'];
      outcome: DesktopSessionDispatchFailure;
    };

export interface SendOutcomeLogContext {
  owner: string;
  entrypoint: string;
  sessionId?: string;
  agentKind?: string;
  action: string;
  context: string;
}

export interface SanitizedSendOutcomeError {
  errorName?: string;
  errorCode?: string;
  errorKind?: string;
  safeMessage?: string;
}

export function createHostSendFailure(
  code: HostSendFailureCode,
  message: string,
  extra?: { busySessionIds?: string[] },
): HostSendOutcome {
  return {
    kind: 'host-send',
    accepted: false,
    code,
    message,
    ...(extra?.busySessionIds ? { busySessionIds: [...extra.busySessionIds] } : {}),
  };
}

export function toDesktopSessionDispatchOutcome(
  result: SessionSendResult,
  meta: { source: string; context: string },
): DesktopSessionDispatchOutcome {
  const outcome = toSessionDispatchOutcome(result, meta.context);
  if (outcome.dispatched) {
    return {
      kind: 'session-dispatch',
      source: meta.source,
      dispatched: true,
    };
  }
  return {
    kind: 'session-dispatch',
    source: meta.source,
    ...outcome,
  };
}

export function toCompatibleMakerSendResult(
  outcome: DesktopSendOutcome,
): DesktopMakerSendResult {
  if (outcome.kind === 'host-send') {
    return {
      accepted: false,
      reason: outcome.code,
      outcome,
    };
  }
  if (outcome.dispatched) {
    return { accepted: true, outcome };
  }
  return {
    accepted: false,
    reason: outcome.reason,
    outcome,
  };
}

const SAFE_ERROR_NAME_RE = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
/**
 * 可外发的错误 code 形态：大写标识符。
 *
 * 之前只认 `HOST_SEND_FAILURE_CODES` 这 8 个，于是 maker-core 的
 * `Session ... is closing` / `PRECONDITION_FAILED` / 伙伴能力刷新等派发前失败全部被压成
 * `safeMessage: 'Error'`：日志里只有 `reason: 'Error'`，渠道里只有「❌ 启动 agent 失败：Error」，
 * 用户和值守的人都无法定位（issue #9636 / #8952）。
 *
 * 放宽的依据是**形态**而不是内容：`code` 是宿主自己赋的枚举标识符（`SESSION_CLOSED`、
 * `PRECONDITION_FAILED`），不是自由文本；自由文本只可能出现在 `message` 里，而 `message`
 * 依然不落日志、不进渠道文案。带空格 / 路径 / 引号的伪 code 仍会被丢弃。
 */
const SAFE_ERROR_CODE_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

export function sanitizeSendOutcomeError(err: unknown): SanitizedSendOutcomeError {
  if (!(err instanceof Error)) {
    return { errorKind: typeof err };
  }
  const rawName = typeof err.name === 'string' ? err.name : '';
  const errorName = SAFE_ERROR_NAME_RE.test(rawName) ? rawName : 'Error';
  const rawCode = (err as { code?: unknown }).code;
  const code = typeof rawCode === 'string' && SAFE_ERROR_CODE_RE.test(rawCode)
    ? rawCode
    : undefined;
  return {
    errorName,
    ...(errorName === 'Error' && rawName !== 'Error' ? { errorKind: 'unknown' } : {}),
    ...(code ? { errorCode: code } : {}),
    safeMessage: code ?? errorName,
  };
}

export function assertDesktopSendDispatched(
  result: SessionSendResult,
  context: string,
): void {
  assertSendDispatched(result, context);
}

export function observeFireAndForgetSendOutcome(
  promise: Promise<SessionSendResult>,
  meta: SendOutcomeLogContext,
): void {
  promise
    .then((result) => {
      const outcome = toDesktopSessionDispatchOutcome(result, {
        source: 'fire-and-forget',
        context: meta.context,
      });
      if (!outcome.dispatched) {
        log.warn('fire-and-forget send not dispatched', {
          kind: outcome.kind,
          source: outcome.source,
          owner: meta.owner,
          entrypoint: meta.entrypoint,
          sessionId: meta.sessionId,
          agentKind: meta.agentKind,
          action: meta.action,
          reason: outcome.reason,
          context: outcome.context,
        });
      }
    })
    .catch((err) => {
      log.warn('fire-and-forget send failed', {
        kind: 'session-dispatch',
        source: 'fire-and-forget',
        owner: meta.owner,
        entrypoint: meta.entrypoint,
        sessionId: meta.sessionId,
        agentKind: meta.agentKind,
        action: meta.action,
        context: meta.context,
        error: sanitizeSendOutcomeError(err),
      });
    });
}
