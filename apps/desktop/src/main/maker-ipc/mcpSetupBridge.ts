import { createDesktopOnlyConfirmationRequestId } from '../cindy-brain/desktopOnlyConfirmationProjection.js';
import { MAKER_PUSH } from './channels.js';
import { HOST_CONFIRM_TIMEOUT_MS } from './hostConfirmTiming.js';
import type { McpSetupProposal, McpSetupRequest, McpSetupResult } from '../../shared/mcpSetup.js';

interface Pending {
  sessionId: string;
  request: McpSetupRequest;
  isCurrent: () => boolean;
  formPresented: boolean;
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
    if (!isCurrent()) return Promise.resolve({ status: 'interrupted' });
    for (const entry of this.pending.values()) {
      if (entry.sessionId !== sessionId) continue;
      if (entry.isCurrent()) {
        const previous = entry.request.proposal;
        if (previous.name === proposal.name && previous.url === proposal.url && previous.transport === proposal.transport) {
          return entry.promise;
        }
        return Promise.resolve({ status: 'unavailable', reason: 'request_in_progress' });
      }
      this.settle(entry.request.requestId, { status: 'interrupted' });
    }
    const request: McpSetupRequest = {
      kind: 'mcp_setup', requestId: createDesktopOnlyConfirmationRequestId(), proposal,
    };
    let resolve!: Pending['resolve'];
    const promise = new Promise<McpSetupResult>(done => { resolve = done; });
    const timer = setTimeout(() => this.settle(request.requestId, isCurrent()
      ? { status: 'timed_out', formPresented: this.pending.get(request.requestId)?.formPresented ?? false }
      : { status: 'interrupted' }),
      this.deps.timeoutMs ?? HOST_CONFIRM_TIMEOUT_MS);
    this.pending.set(request.requestId, { sessionId, request, isCurrent, formPresented: false, promise, resolve, timer });
    try {
      this.deps.broadcast(MAKER_PUSH.INTERACTION_REQUEST, { sessionId, request });
    } catch {
      this.settle(request.requestId, { status: 'unavailable', reason: 'presentation_failed' });
    }
    return promise;
  }

  has(requestId: string): boolean { return this.pending.has(requestId); }

  pendingSnapshots(sessionId?: string): Array<{ sessionId: string; request: McpSetupRequest }> {
    return [...this.pending.values()].flatMap(entry => {
      if (!entry.isCurrent()) {
        this.settle(entry.request.requestId, { status: 'interrupted' });
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
    if (!entry.isCurrent()) {
      this.settle(requestId, { status: 'interrupted' });
      return true;
    }
    if (value.status === 'presented') {
      entry.formPresented = true;
      return true;
    }
    if (value.status === 'cancelled') {
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
      if (entry.sessionId === sessionId) this.settle(entry.request.requestId, { status: 'interrupted' });
    }
  }

  cleanupAll(): void {
    for (const id of this.pending.keys()) this.settle(id, { status: 'interrupted' });
  }

  private settle(requestId: string, result: McpSetupResult): void {
    const entry = this.pending.get(requestId);
    if (!entry) return;
    this.pending.delete(requestId);
    clearTimeout(entry.timer);
    entry.resolve(result);
    try { this.deps.broadcast(MAKER_PUSH.INTERACTION_DISMISSED, {
      sessionId: entry.sessionId, requestId, reason: 'resolved',
      resolvedAs: result.status === 'saved' ? 'allow' : 'deny',
    }); } catch { /* The waiter is settled even if its renderer has closed. */ }
  }
}

/** Preserve the saved receipt even when the engine cannot refresh or inspect it.
 * Only engine metadata returns to the model; no credentials or business calls.
 */
export async function completeMcpSetup(result: McpSetupResult, deps: {
  isCurrent: () => boolean;
  mount: (serverId: string) => Promise<boolean>;
  read: (serverId: string) => Promise<{ state: string; tools: unknown[] } | null>;
}): Promise<McpSetupResult> {
  if (result.status !== 'saved') return result;
  if (!deps.isCurrent()) return { status: 'interrupted' };
  try {
    await deps.mount(result.serverId);
    if (!deps.isCurrent()) return { status: 'interrupted' };
    const report = await deps.read(result.serverId);
    if (!deps.isCurrent()) return { status: 'interrupted' };
    return { ...result, runtimeState: report?.state ?? 'unverified',
      ...(report ? { toolCount: report.tools.length } : { runtimeReason: 'status_unavailable' as const }) };
  } catch {
    return deps.isCurrent() ? { ...result, runtimeState: 'unverified', runtimeReason: 'check_failed' } : { status: 'interrupted' };
  }
}
