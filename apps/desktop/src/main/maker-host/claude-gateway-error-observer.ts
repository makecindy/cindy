/**
 * Claude XD Gateway 错误观察器。
 *
 * 路由 transform 与响应 observer 通过 proxy reqId 关联，只有同一个 Opus 请求
 * 确认走 XD Gateway 且收到特定 400 套餐错误时才留下待消费证据。terminal event
 * 到达时还要求它仍是该会话最新请求；后续 retry / tool 请求会使旧证据失效。
 */

import type { ResponseObserver, ResponseObserverCtx } from '@cindy/anthropic-compat-proxy';

import {
  CLAUDE_GATEWAY_OPUS_PLAN_MISMATCH_REASON,
  classifyClaudeGatewayError,
} from '../../shared/claudeGatewayError.js';
import {
  readLatestClaudeSessionRequestId,
  takeClaudeRequestRoute,
} from './claude-session-route-registry.js';
import { decodeUpstreamErrorBody } from './provider-upstream-error-observer.js';

const MAX_ERROR_BODY_BYTES = 16 * 1024;
const MAX_PENDING_SESSIONS = 128;

interface PendingMismatch {
  reqId: number;
  reason: typeof CLAUDE_GATEWAY_OPUS_PLAN_MISMATCH_REASON;
}

const pendingMismatches = new Map<string, PendingMismatch>();

function requestModel(requestBody: Buffer): string {
  try {
    const parsed = JSON.parse(requestBody.toString('utf-8')) as { model?: unknown };
    return typeof parsed.model === 'string' ? parsed.model : '';
  } catch {
    return '';
  }
}

function recordPendingMismatch(sessionId: string, mismatch: PendingMismatch): void {
  pendingMismatches.delete(sessionId);
  pendingMismatches.set(sessionId, mismatch);
  while (pendingMismatches.size > MAX_PENDING_SESSIONS) {
    const oldestSessionId = pendingMismatches.keys().next().value as string | undefined;
    if (oldestSessionId === undefined) break;
    pendingMismatches.delete(oldestSessionId);
  }
}

export function createClaudeGatewayErrorObserver(): ResponseObserver {
  return (ctx: ResponseObserverCtx) => {
    const requestRoute = takeClaudeRequestRoute(ctx.reqId);
    if (!requestRoute || requestRoute.route !== 'gateway' || ctx.status !== 400) return null;

    const modelId = requestModel(ctx.requestBody);
    if (!modelId.startsWith('claude-opus-')) return null;

    const chunks: Buffer[] = [];
    let size = 0;
    return {
      onData: (chunk: Buffer) => {
        if (size >= MAX_ERROR_BODY_BYTES) return;
        const remaining = MAX_ERROR_BODY_BYTES - size;
        chunks.push(chunk.subarray(0, remaining));
        size += Math.min(chunk.length, remaining);
      },
      onEnd: () => {
        const encoding = ctx.responseHeaders['content-encoding'];
        const bodyText = decodeUpstreamErrorBody(
          Buffer.concat(chunks, size),
          typeof encoding === 'string' ? encoding : undefined,
        );
        const reason = classifyClaudeGatewayError({
          modelId,
          requestRoute: requestRoute.route,
          status: ctx.status,
          error: bodyText,
        });
        if (
          reason &&
          readLatestClaudeSessionRequestId(requestRoute.sessionId) === ctx.reqId
        ) {
          recordPendingMismatch(requestRoute.sessionId, { reqId: ctx.reqId, reason });
        }
      },
      onError: () => {},
    };
  };
}

/** terminal error 转发点一次性消费；后续请求已开始时保守放弃旧证据。 */
export function consumeClaudeGatewayOpusPlanMismatch(
  sessionId: string,
): typeof CLAUDE_GATEWAY_OPUS_PLAN_MISMATCH_REASON | null {
  const pending = pendingMismatches.get(sessionId) ?? null;
  pendingMismatches.delete(sessionId);
  if (!pending || readLatestClaudeSessionRequestId(sessionId) !== pending.reqId) return null;
  return pending.reason;
}

export function resetClaudeGatewayErrorObserverForTest(): void {
  pendingMismatches.clear();
}
