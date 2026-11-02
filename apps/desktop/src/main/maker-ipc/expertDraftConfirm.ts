/**
 * Owner approval for expert drafts (ROADMAP 3.8, ADR 0005 option A, ADR 0007).
 *
 * The `draft_expert` tool asks here and waits. The renderer shows the draft on a card in that
 * session; Approve or Reject settles the wait. No answer within the host-confirm timeout counts
 * as a rejection, so nothing is ever written without an explicit Approve. One draft per session
 * at a time. Electron-free: events go to listeners, the IPC layer broadcasts them.
 */

import { randomUUID } from 'node:crypto';

import type { ExpertDraft } from '@cindy/maker-core/expert-draft';

import { HOST_CONFIRM_TIMEOUT_MS } from './hostConfirmTiming.js';

export const MAX_EXPERT_DRAFT_NOTE_CHARS = 2000;

export interface ExpertDraftRequest {
  requestId: string;
  sessionId: string;
  draft: ExpertDraft;
  /** Folder Approve creates. */
  targetDir: string;
  /** The exact expert.md Approve writes. */
  markdown: string;
  createdAt: number;
  expiresAt: number;
}

export type ExpertDraftDecision =
  | { approved: true }
  | { approved: false; reason: 'rejected' | 'timeout'; note?: string };

export type ExpertDraftEvent =
  | { type: 'request'; request: ExpertDraftRequest }
  | { type: 'settled'; requestId: string; sessionId: string; outcome: 'approved' | 'rejected' | 'timeout' };

interface Pending {
  request: ExpertDraftRequest;
  resolve: (decision: ExpertDraftDecision) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface ExpertDraftConfirmOptions {
  timeoutMs?: number;
  now?: () => number;
}

export class ExpertDraftConfirm {
  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Set<(event: ExpertDraftEvent) => void>();
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(opts: ExpertDraftConfirmOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? HOST_CONFIRM_TIMEOUT_MS;
    this.now = opts.now ?? Date.now;
  }

  onChange(listener: (event: ExpertDraftEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: ExpertDraftEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A broken listener must not break the approval flow.
      }
    }
  }

  hasPending(sessionId: string): boolean {
    return [...this.pending.values()].some((p) => p.request.sessionId === sessionId);
  }

  /** Requests still waiting, for a renderer that opened the session after the push. */
  list(sessionId?: string): ExpertDraftRequest[] {
    return [...this.pending.values()]
      .map((p) => p.request)
      .filter((r) => sessionId === undefined || r.sessionId === sessionId);
  }

  /** Show the draft to the owner and wait for Approve / Reject / timeout. */
  request(input: { sessionId: string; draft: ExpertDraft; targetDir: string; markdown: string }): Promise<ExpertDraftDecision> {
    if (this.hasPending(input.sessionId)) {
      return Promise.reject(new Error('a draft from this session is already waiting for the owner'));
    }
    const createdAt = this.now();
    const request: ExpertDraftRequest = {
      requestId: randomUUID(),
      ...input,
      createdAt,
      expiresAt: createdAt + this.timeoutMs,
    };
    return new Promise<ExpertDraftDecision>((resolve) => {
      const timer = setTimeout(() => this.settle(request.requestId, { approved: false, reason: 'timeout' }), this.timeoutMs);
      this.pending.set(request.requestId, { request, resolve, timer });
      this.emit({ type: 'request', request });
    });
  }

  /** Renderer answer. Returns false for an unknown or already-settled request. Bad shapes reject. */
  decide(requestId: unknown, raw: unknown): boolean {
    if (typeof requestId !== 'string' || !this.pending.has(requestId)) return false;
    const body = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    if (body.approved === true) return this.settle(requestId, { approved: true });
    const note = typeof body.note === 'string' ? body.note.trim().slice(0, MAX_EXPERT_DRAFT_NOTE_CHARS) : '';
    return this.settle(requestId, { approved: false, reason: 'rejected', ...(note ? { note } : {}) });
  }

  private settle(requestId: string, decision: ExpertDraftDecision): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    this.pending.delete(requestId);
    clearTimeout(entry.timer);
    entry.resolve(decision);
    this.emit({
      type: 'settled',
      requestId,
      sessionId: entry.request.sessionId,
      outcome: decision.approved ? 'approved' : decision.reason,
    });
    return true;
  }
}

let desktopConfirm: ExpertDraftConfirm | undefined;

/** The one instance the draft_expert tool and the IPC handlers share. */
export function getDesktopExpertDraftConfirm(): ExpertDraftConfirm {
  desktopConfirm ??= new ExpertDraftConfirm();
  return desktopConfirm;
}
