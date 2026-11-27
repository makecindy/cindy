import { createDesktopOnlyConfirmationRequestId } from '../cindy-brain/desktopOnlyConfirmationProjection.js';
import { MAKER_PUSH } from './channels.js';
import { HOST_CONFIRM_TIMEOUT_MS } from './hostConfirmTiming.js';
import type { McpSetupProposal, McpSetupRequest, McpSetupResult } from '../../shared/mcpSetup.js';

interface Pending {
  sessionId: string;
  request: McpSetupRequest;
  isCurrent: () => boolean;
  promise: Promise<McpSetupResult>;
  resolve: (result: McpSetupResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Same ephemeral request/wait/resolve pattern as the other Desktop confirmations. */
export class McpSetupBridge {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly deps: {
    broadcast: (channel: string, payload: unknown) => void;
    timeoutMs?: number;
  }) {}

  request(sessionId: string, proposal: McpSetupProposal, isCurrent: () => boolean): Promise<McpSetupResult> {
    if (!isCurrent()) return Promise.resolve({ status: 'cancelled' });
    for (const entry of this.pending.values()) {
      if (entry.sessionId !== sessionId) continue;
      if (entry.isCurrent()) return entry.promise;
      this.settle(entry.request.requestId, { status: 'cancelled' });
    }
    const request: McpSetupRequest = {
      kind: 'mcp_setup', requestId: createDesktopOnlyConfirmationRequestId(), proposal,
    };
    let resolve!: Pending['resolve'];
    const promise = new Promise<McpSetupResult>(done => { resolve = done; });
    const timer = setTimeout(() => this.settle(request.requestId, { status: 'cancelled' }),
      this.deps.timeoutMs ?? HOST_CONFIRM_TIMEOUT_MS);
    this.pending.set(request.requestId, { sessionId, request, isCurrent, promise, resolve, timer });
    try {
      this.deps.broadcast(MAKER_PUSH.INTERACTION_REQUEST, { sessionId, request });
    } catch {
      this.settle(request.requestId, { status: 'cancelled' });
    }
    return promise;
  }

  has(requestId: string): boolean { return this.pending.has(requestId); }

  pendingSnapshots(sessionId?: string): Array<{ sessionId: string; request: McpSetupRequest }> {
    return [...this.pending.values()].flatMap(entry => {
      if (!entry.isCurrent()) {
        this.settle(entry.request.requestId, { status: 'cancelled' });
        return [];
      }
      return sessionId === undefined || entry.sessionId === sessionId
        ? [{ sessionId: entry.sessionId, request: entry.request }] : [];
    });
  }

  resolve(requestId: string, decision: unknown): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    const value = decision as Record<string, unknown> | null;
    if (!value || value.kind !== 'mcp_setup') return false;
    if (value.status === 'cancelled' || !entry.isCurrent()) {
      this.settle(requestId, { status: 'cancelled' });
      return true;
    }
    if (value.status !== 'saved' || typeof value.serverId !== 'string' ||
      !/^custom_[a-z0-9_-]{1,33}$/.test(value.serverId)) return false;
    this.settle(requestId, { status: 'saved', serverId: value.serverId });
    return true;
  }

  cleanupForSession(sessionId: string): void {
    for (const entry of this.pending.values()) {
      if (entry.sessionId === sessionId) this.settle(entry.request.requestId, { status: 'cancelled' });
    }
  }

  cleanupAll(): void {
    for (const id of this.pending.keys()) this.settle(id, { status: 'cancelled' });
  }

  private settle(requestId: string, result: McpSetupResult): void {
    const entry = this.pending.get(requestId);
    if (!entry) return;
    this.pending.delete(requestId);
    clearTimeout(entry.timer);
    entry.resolve(result);
    this.deps.broadcast(MAKER_PUSH.INTERACTION_DISMISSED, {
      sessionId: entry.sessionId, requestId, reason: 'resolved',
      resolvedAs: result.status === 'saved' ? 'allow' : 'deny',
    });
  }
}
