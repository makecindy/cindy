import { randomUUID } from 'node:crypto';

import type { InteractionDecision, InteractionRequest } from '@cindy/maker-core';

import { MAKER_PUSH } from './channels.js';
import { HOST_CONFIRM_TIMEOUT_MS } from './hostConfirmTiming.js';

export type OrcaWorkerPermissionConfirmDecision =
  | { confirmed: true }
  | {
      confirmed: false;
      reason: 'cancelled' | 'timeout' | 'session_closed' | 'session_aborted';
    };

export interface OrcaWorkerPermissionConfirmCopy {
  title: string;
  description: string;
}

export interface OrcaWorkerPermissionConfirmBridgeDeps {
  broadcast: (channel: string, payload: unknown) => void;
  timeoutMs?: number;
  logger?: { warn: (...args: unknown[]) => void };
}

interface PendingConfirmEntry {
  sessionId: string;
  request: Extract<InteractionRequest, { kind: 'permission' }>;
  promise: Promise<OrcaWorkerPermissionConfirmDecision>;
  resolve: (decision: OrcaWorkerPermissionConfirmDecision) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

/**
 * start_team 把 Worker 默认权限从 Auto 提升到 Full access 前的宿主确认桥。
 *
 * 这条确认由 Main 主动发起，不依赖 MCP / Agent 自己的审批回调，因此即使 Lead
 * 当前已是 Full access、底层 SDK 跳过 canUseTool，模型也不能自行越过它。
 */
export class OrcaWorkerPermissionConfirmBridge {
  private readonly pending = new Map<string, PendingConfirmEntry>();
  private readonly pendingRequestIdBySession = new Map<string, string>();

  constructor(private readonly deps: OrcaWorkerPermissionConfirmBridgeDeps) {}

  request(
    sessionId: string,
    copy: OrcaWorkerPermissionConfirmCopy,
  ): Promise<OrcaWorkerPermissionConfirmDecision> {
    const existingRequestId = this.pendingRequestIdBySession.get(sessionId);
    const existing = existingRequestId ? this.pending.get(existingRequestId) : undefined;
    if (existing) return existing.promise;

    const requestId = randomUUID();
    const request: Extract<InteractionRequest, { kind: 'permission' }> = {
      kind: 'permission',
      requestId,
      toolName: 'mcp__cindy_orca__start_team',
      input: { worker_permission_mode: 'bypassPermissions' },
      title: copy.title,
      description: copy.description,
      metadata: { hostOwnedConfirmation: 'orca_worker_full_access' },
    };
    let settlePromise!: (decision: OrcaWorkerPermissionConfirmDecision) => void;
    const promise = new Promise<OrcaWorkerPermissionConfirmDecision>((resolve) => {
      settlePromise = resolve;
    });
    const timeoutId = setTimeout(() => {
      this.settle(requestId, { confirmed: false, reason: 'timeout' }, 'timeout');
    }, this.deps.timeoutMs ?? HOST_CONFIRM_TIMEOUT_MS);
    this.pending.set(requestId, {
      sessionId,
      request,
      promise,
      resolve: settlePromise,
      timeoutId,
    });
    this.pendingRequestIdBySession.set(sessionId, requestId);
    this.deps.broadcast(MAKER_PUSH.INTERACTION_REQUEST, { sessionId, request });
    return promise;
  }

  pendingSnapshots(sessionId?: string): Array<{
    sessionId: string;
    request: Extract<InteractionRequest, { kind: 'permission' }>;
  }> {
    return Array.from(this.pending.values())
      .filter((entry) => sessionId === undefined || entry.sessionId === sessionId)
      .map((entry) => ({ sessionId: entry.sessionId, request: entry.request }));
  }

  hasPending(requestId: string): boolean {
    return this.pending.has(requestId);
  }

  resolve(requestId: string, rawDecision: unknown): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    const decision = parseDecision(rawDecision);
    if (!decision) {
      this.deps.logger?.warn(
        'orca worker permission confirm: invalid decision shape, treated as cancelled',
        { requestId },
      );
    }
    this.settlePending(requestId, entry, decision ?? { confirmed: false, reason: 'cancelled' });
    this.deps.broadcast(MAKER_PUSH.INTERACTION_DISMISSED, {
      sessionId: entry.sessionId,
      requestId,
      reason: 'resolved',
      resolvedAs: decision?.confirmed ? 'allow' : 'deny',
    });
    return true;
  }

  resolveFromIpc(
    requestId: string,
    rawDecision: unknown,
    origin: { isDeviceLink: boolean; assertTrustedSender: () => void },
  ): boolean {
    if (!this.pending.has(requestId)) return false;
    if (!origin.isDeviceLink) origin.assertTrustedSender();
    return this.resolve(requestId, rawDecision);
  }

  cleanupForSession(sessionId: string, reason: 'session_closed' | 'session_aborted'): void {
    for (const [requestId, entry] of Array.from(this.pending.entries())) {
      if (entry.sessionId !== sessionId) continue;
      this.settle(requestId, { confirmed: false, reason }, reason);
    }
  }

  private settle(
    requestId: string,
    decision: OrcaWorkerPermissionConfirmDecision & { confirmed: false },
    dismissReason: string,
  ): void {
    const entry = this.pending.get(requestId);
    if (!entry) return;
    this.settlePending(requestId, entry, decision);
    this.deps.broadcast(MAKER_PUSH.INTERACTION_DISMISSED, {
      sessionId: entry.sessionId,
      requestId,
      reason: dismissReason,
      resolvedAs: 'deny',
    });
  }

  private settlePending(
    requestId: string,
    entry: PendingConfirmEntry,
    decision: OrcaWorkerPermissionConfirmDecision,
  ): void {
    this.pending.delete(requestId);
    if (this.pendingRequestIdBySession.get(entry.sessionId) === requestId) {
      this.pendingRequestIdBySession.delete(entry.sessionId);
    }
    clearTimeout(entry.timeoutId);
    entry.resolve(decision);
  }
}

function parseDecision(raw: unknown): OrcaWorkerPermissionConfirmDecision | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const decision = raw as Partial<InteractionDecision> & { kind?: unknown; behavior?: unknown };
  if (decision.kind !== 'permission') return null;
  if (decision.behavior === 'allow') return { confirmed: true };
  if (decision.behavior === 'deny') return { confirmed: false, reason: 'cancelled' };
  return null;
}
