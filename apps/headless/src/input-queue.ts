import { randomUUID } from 'node:crypto';
import type {
  HeadlessInputQueueState,
  HeadlessQueuedInput,
  HeadlessSessionEvent,
  HeadlessSessionEventSource,
  HeadlessSessionEventStorage,
  HeadlessSessionMeta,
  HeadlessSessionStorageContract,
} from './session-types.js';
import type { UserMessage } from '@cindy/maker-core';

type QueueStorage = HeadlessSessionStorageContract & HeadlessSessionEventStorage & HeadlessSessionEventSource & {
  listInputQueue(sessionId: string): Promise<HeadlessQueuedInput[]>;
  enqueueInput(sessionId: string, clientId: string, payload: Record<string, unknown>): Promise<HeadlessQueuedInput>;
  setInputState(sessionId: string, clientId: string, state: HeadlessQueuedInput['state']): Promise<void>;
  removeInput(sessionId: string, clientId: string): Promise<void>;
  clearInputQueue(sessionId: string): Promise<void>;
  updateInput(sessionId: string, clientId: string, payload: Record<string, unknown>): Promise<void>;
  moveInput(sessionId: string, clientId: string, targetIndex: number): Promise<void>;
  getInputQueueState(sessionId: string): Promise<HeadlessInputQueueState>;
  updateInputQueueState(sessionId: string, patch: Partial<Omit<HeadlessInputQueueState, 'sessionId'>>): Promise<HeadlessInputQueueState>;
  recoverActiveInputQueue(): Promise<void>;
};

type QueueRuntime = {
  send(session: HeadlessSessionMeta, content: string | UserMessage): Promise<void>;
  /** Optional on older test/runtime adapters; native runtime preserves the mobile optimistic row ID. */
  sendWithClientId?(session: HeadlessSessionMeta, content: string | UserMessage, clientId: string, displayContent?: unknown): Promise<void>;
  steer(session: HeadlessSessionMeta, content: string | UserMessage): Promise<void>;
  abort(sessionId: string): Promise<void>;
  isSessionBusy(sessionId: string): boolean;
};

/** The projection shape shared with Desktop/Mobile input queues. */
export type HeadlessInputProjection = {
  sessionId: string;
  pendingQueue: Array<Record<string, unknown>>;
  steeringQueueClientIds: string[];
  queuePaused: boolean;
  queueExpanded: boolean;
  queueInteractionLocks: string[];
  queueEditLocks: string[];
  queueAbortPending: boolean;
  error: null;
  recovery: null;
  errorRetryText: null;
  credentialSwitchWait: null;
};

/**
 * Durable queue adapter for the headless runtime. It keeps the wire-level
 * queue contract authoritative on Linux rather than acknowledging mutations
 * as no-ops. The agent runtime remains the only executor; this layer merely
 * controls dispatch timing and preserves the queue across daemon restarts.
 */
export class HeadlessInputQueue {
  private readonly draining = new Set<string>();
  private readonly listeners = new Set<(projection: HeadlessInputProjection) => void>();
  private stopEvents: (() => void) | null = null;

  constructor(
    private readonly storage: QueueStorage,
    private readonly runtime: QueueRuntime,
    private readonly normalizeQueuedContent: (sessionId: string, payload: Record<string, unknown>) => Promise<string | UserMessage> = async (_sessionId, payload) => queueText(payload)!,
    private readonly displayQueuedContent: (content: string | UserMessage) => unknown = (content) => content,
  ) {}

  async start(): Promise<void> {
    if (this.stopEvents) return;
    await this.storage.recoverActiveInputQueue();
    this.stopEvents = this.storage.onEvent((event) => { void this.handleEvent(event); });
    for (const session of await this.storage.list()) void this.drain(session.id);
  }

  stop(): void {
    this.stopEvents?.();
    this.stopEvents = null;
    this.draining.clear();
  }

  onProjection(listener: (projection: HeadlessInputProjection) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async projection(sessionId: string): Promise<HeadlessInputProjection> {
    if (!await this.storage.get(sessionId)) throw new Error(`Unknown session: ${sessionId}`);
    return this.buildProjection(sessionId);
  }

  async enqueue(sessionId: string, item: unknown): Promise<HeadlessInputProjection> {
    const payload = queuePayload(item);
    const clientId = stringField(payload, 'clientId') ?? `headless-${randomUUID()}`;
    if (!stringField(payload, 'clientId')) payload.clientId = clientId;
    if (!hasQueueContent(payload)) throw new Error('queued message must contain text or an attachment');
    if (!await this.storage.get(sessionId)) throw new Error(`Unknown session: ${sessionId}`);
    await this.storage.enqueueInput(sessionId, clientId, payload);
    const projection = await this.buildProjection(sessionId);
    this.emit(projection);
    void this.drain(sessionId);
    return projection;
  }

  async steer(sessionId: string, item: unknown, removeFromQueue = false): Promise<boolean> {
    const payload = queuePayload(item);
    if (!hasQueueContent(payload)) throw new Error('queued message must contain text or an attachment');
    const session = await this.requireSession(sessionId);
    const clientId = stringField(payload, 'clientId');
    if (removeFromQueue && clientId) await this.storage.removeInput(sessionId, clientId);
    await this.runtime.steer(session, await this.normalizeQueuedContent(sessionId, payload));
    this.emit(await this.buildProjection(sessionId));
    return true;
  }

  async stopSession(sessionId: string, options: { keepQueue?: boolean; pauseQueue?: boolean } = {}): Promise<HeadlessInputProjection> {
    if (!options.keepQueue) await this.storage.clearInputQueue(sessionId);
    if (options.pauseQueue !== undefined) await this.storage.updateInputQueueState(sessionId, { queuePaused: options.pauseQueue });
    // A paused/pending-only queue may not have a live Maker session yet;
    // stopping it should clear or pause queued input without manufacturing an
    // "not attached" runtime error.
    if (this.runtime.isSessionBusy(sessionId)) await this.runtime.abort(sessionId);
    const projection = await this.buildProjection(sessionId);
    this.emit(projection);
    return projection;
  }

  async remove(sessionId: string, clientId: string): Promise<HeadlessInputProjection> {
    await this.storage.removeInput(sessionId, clientId);
    const projection = await this.buildProjection(sessionId);
    this.emit(projection);
    void this.drain(sessionId);
    return projection;
  }

  async updateText(sessionId: string, clientId: string, text: string): Promise<HeadlessInputProjection> {
    const current = (await this.storage.listInputQueue(sessionId)).find((item) => item.clientId === clientId && item.state === 'queued');
    if (!current) throw new Error('Queued message is no longer editable');
    const value = text.trim();
    if (!value) throw new Error('queued message text must be a non-empty string');
    const payload: Record<string, unknown> = { ...current.payload, text: value };
    const chatMessage = record(payload.chatMessage);
    if (chatMessage) payload.chatMessage = { ...chatMessage, content: value };
    await this.storage.updateInput(sessionId, clientId, payload);
    const projection = await this.buildProjection(sessionId);
    this.emit(projection);
    return projection;
  }

  async updateContent(sessionId: string, clientId: string, item: unknown): Promise<HeadlessInputProjection> {
    const payload = queuePayload(item);
    if (!hasQueueContent(payload)) throw new Error('queued message must contain text or an attachment');
    await this.storage.updateInput(sessionId, clientId, { ...payload, clientId });
    const projection = await this.buildProjection(sessionId);
    this.emit(projection);
    return projection;
  }

  async move(sessionId: string, clientId: string, targetIndex: number): Promise<HeadlessInputProjection> {
    if (!Number.isInteger(targetIndex)) throw new Error('targetIndex must be an integer');
    await this.storage.moveInput(sessionId, clientId, targetIndex);
    const projection = await this.buildProjection(sessionId);
    this.emit(projection);
    return projection;
  }

  async setExpanded(sessionId: string, expanded: boolean): Promise<HeadlessInputProjection> {
    await this.storage.updateInputQueueState(sessionId, { queueExpanded: expanded });
    return this.publish(sessionId);
  }

  async setInteractionLock(sessionId: string, lockId: string, locked: boolean): Promise<HeadlessInputProjection> {
    const state = await this.storage.getInputQueueState(sessionId);
    const queueInteractionLocks = toggle(state.queueInteractionLocks, lockId, locked);
    await this.storage.updateInputQueueState(sessionId, { queueInteractionLocks });
    return this.publish(sessionId);
  }

  async setEditLock(sessionId: string, clientId: string, locked: boolean): Promise<HeadlessInputProjection> {
    const state = await this.storage.getInputQueueState(sessionId);
    const queueEditLocks = toggle(state.queueEditLocks, clientId, locked);
    await this.storage.updateInputQueueState(sessionId, { queueEditLocks });
    const projection = await this.buildProjection(sessionId);
    this.emit(projection);
    if (!locked) void this.drain(sessionId);
    return projection;
  }

  async resume(sessionId: string): Promise<HeadlessInputProjection> {
    await this.storage.updateInputQueueState(sessionId, { queuePaused: false });
    const projection = await this.buildProjection(sessionId);
    this.emit(projection);
    void this.drain(sessionId);
    return projection;
  }

  async clearSession(sessionId: string): Promise<HeadlessInputProjection> {
    await this.storage.clearInputQueue(sessionId);
    await this.storage.updateInputQueueState(sessionId, {
      queuePaused: false, queueExpanded: false, queueInteractionLocks: [], queueEditLocks: [],
    });
    return this.publish(sessionId);
  }

  private async handleEvent(event: HeadlessSessionEvent): Promise<void> {
    if (!isTerminalEvent(event)) return;
    const active = (await this.storage.listInputQueue(event.sessionId)).find((item) => item.state === 'active');
    if (!active) {
      void this.drain(event.sessionId);
      return;
    }
    await this.storage.removeInput(event.sessionId, active.clientId);
    this.emit(await this.buildProjection(event.sessionId));
    void this.drain(event.sessionId);
  }

  private async drain(sessionId: string): Promise<void> {
    if (this.draining.has(sessionId)) return;
    this.draining.add(sessionId);
    try {
      const state = await this.storage.getInputQueueState(sessionId);
      if (state.queuePaused || this.runtime.isSessionBusy(sessionId)) return;
      const rows = await this.storage.listInputQueue(sessionId);
      if (rows.some((item) => item.state === 'active')) return;
      const next = rows.find((item) => item.state === 'queued' && !state.queueEditLocks.includes(item.clientId));
      if (!next) return;
      const session = await this.requireSession(sessionId);
      await this.storage.setInputState(sessionId, next.clientId, 'active');
      this.emit(await this.buildProjection(sessionId));
      const content = await this.normalizeQueuedContent(sessionId, next.payload);
      if (this.runtime.sendWithClientId) await this.runtime.sendWithClientId(session, content, next.clientId, this.displayQueuedContent(content));
      else await this.runtime.send(session, content);
    } finally {
      this.draining.delete(sessionId);
    }
  }

  private async requireSession(sessionId: string): Promise<HeadlessSessionMeta> {
    const session = await this.storage.get(sessionId);
    if (!session) throw new Error(`Unknown session: ${sessionId}`);
    return session;
  }

  private async buildProjection(sessionId: string): Promise<HeadlessInputProjection> {
    const [rows, state] = await Promise.all([this.storage.listInputQueue(sessionId), this.storage.getInputQueueState(sessionId)]);
    return {
      sessionId,
      pendingQueue: rows.filter((item) => item.state === 'queued').map((item) => item.payload),
      steeringQueueClientIds: [],
      queuePaused: state.queuePaused,
      queueExpanded: state.queueExpanded,
      queueInteractionLocks: state.queueInteractionLocks,
      queueEditLocks: state.queueEditLocks,
      queueAbortPending: false,
      error: null,
      recovery: null,
      errorRetryText: null,
      credentialSwitchWait: null,
    };
  }

  private async publish(sessionId: string): Promise<HeadlessInputProjection> {
    const projection = await this.buildProjection(sessionId);
    this.emit(projection);
    return projection;
  }

  private emit(projection: HeadlessInputProjection): void {
    for (const listener of this.listeners) listener(projection);
  }
}

function queuePayload(value: unknown): Record<string, unknown> {
  const payload = record(value);
  if (!payload) throw new Error('queued message must be an object');
  return { ...payload };
}

function queueText(payload: Record<string, unknown>): string | null {
  const direct = stringField(payload, 'text');
  if (direct) return direct;
  const chat = record(payload.chatMessage);
  return chat ? stringField(chat, 'content') : null;
}

function hasQueueContent(payload: Record<string, unknown>): boolean {
  return Boolean(queueText(payload)) || (Array.isArray(payload.files) && payload.files.length > 0);
}

function stringField(value: Record<string, unknown>, key: string): string | null {
  const item = value[key];
  return typeof item === 'string' && item.trim() ? item.trim() : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function toggle(values: string[], value: string, enabled: boolean): string[] {
  if (!value) return values;
  const set = new Set(values);
  if (enabled) set.add(value); else set.delete(value);
  return [...set];
}

function isTerminalEvent(event: HeadlessSessionEvent): boolean {
  if (event.type === 'session_status') {
    const status = record(event.data)?.status;
    return status === 'closed' || status === 'error';
  }
  if (event.type !== 'agent_event') return false;
  const type = record(event.data)?.type;
  return type === 'done' || type === 'error';
}
