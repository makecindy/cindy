import { randomUUID } from 'node:crypto';
import type { AgentEvent } from '@cindy/maker-core';
import {
  getModerationIdentity,
  isModerationIdentityCurrent,
} from './identity.js';
import {
  StreamModerationClient,
  type CreateStreamModerationInput,
  type StreamModerationCallbacks,
} from './streamClient.js';
import { CONTENT_MODERATION_BLOCKED_MESSAGE } from './constants.js';

const STARTUP_FAIL_OPEN_MS = 5_000;

type Mode = 'idle' | 'starting' | 'active' | 'fail-open' | 'terminal';
type TerminalKind = 'blocked' | 'failed' | 'cancelled' | 'identity-changed';

type ReleaseBoundary = { kind: 'boundary'; resolve: () => void };
type StartupEntry =
  | { kind: 'event'; event: AgentEvent }
  | ReleaseBoundary;
type PendingEntry =
  | { kind: 'text'; sequence: number; event: AgentEvent }
  | { kind: 'event'; event: AgentEvent; terminalBarrier: boolean }
  | ReleaseBoundary;

type CreateStream = (
  input: CreateStreamModerationInput,
  callbacks: StreamModerationCallbacks,
) => Promise<StreamModerationClient | null>;

export interface OutputModerationGateOptions {
  sessionId: string;
  agentKind?: string;
  deliver(event: AgentEvent): void;
  abortTurn(): Promise<void>;
  onBlocked(turnId: string): void;
  onFailed(turnId: string): void;
  createStream?: CreateStream;
}

function textEvent(event: AgentEvent): { text: string; isFinal: boolean } | null {
  if (event.type !== 'text' || !event.data || typeof event.data !== 'object') return null;
  const data = event.data as { text?: unknown; isFinal?: unknown };
  if (typeof data.text !== 'string') return null;
  return { text: data.text, isFinal: data.isFinal === true };
}

function terminalError(event: AgentEvent): boolean {
  if (event.type !== 'error' || !event.data || typeof event.data !== 'object') return false;
  const data = event.data as { isTerminal?: unknown; willRetry?: unknown };
  if (typeof data.isTerminal === 'boolean') return data.isTerminal;
  return data.willRetry !== true;
}

function isRunningStatus(event: AgentEvent, running: boolean): boolean {
  if (event.type !== 'status' || !event.data || typeof event.data !== 'object') return false;
  return (event.data as { isRunning?: unknown }).isRunning === running;
}

function withText(event: AgentEvent, text: string, isFinal?: boolean): AgentEvent {
  return {
    ...event,
    data: {
      ...(event.data && typeof event.data === 'object' ? event.data : {}),
      text,
      ...(typeof isFinal === 'boolean' ? { isFinal } : {}),
    },
  } as AgentEvent;
}

export class OutputModerationGate {
  private mode: Mode = 'idle';
  private terminalKind: TerminalKind | null = null;
  private identity: ReturnType<typeof getModerationIdentity> = null;
  private stream: StreamModerationClient | null = null;
  private startupQueue: StartupEntry[] = [];
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private startupAbort: AbortController | null = null;
  private pending: PendingEntry[] = [];
  private releasedBySequence = new Map<number, string>();
  private currentBlockSubmittedText = '';
  private releasedBlockText = '';
  private releasedText = '';
  private turnId = '';
  private finishSent = false;
  private completionApproved = false;
  private lastTurnEvent: AgentEvent | null = null;
  private terminalSettleDelivered = false;

  constructor(private readonly options: OutputModerationGateOptions) {}

  handle(event: AgentEvent): void {
    if (this.mode === 'starting') {
      this.lastTurnEvent = event;
      this.startupQueue.push({ kind: 'event', event });
      return;
    }
    if (this.mode === 'active') {
      this.lastTurnEvent = event;
      this.handleActive(event);
      return;
    }
    if (this.mode === 'terminal') {
      this.handleTerminal(event);
      return;
    }
    if (this.mode === 'fail-open') {
      this.deliverFailOpen(event);
      return;
    }

    const text = textEvent(event);
    if (text?.isFinal && text.text.length === 0) {
      this.options.deliver(event);
      return;
    }
    if (!text && !isRunningStatus(event, true)) {
      this.options.deliver(event);
      return;
    }
    const identity = getModerationIdentity();
    if (!identity) {
      this.options.deliver(event);
      return;
    }
    this.beginTurn(event, identity);
  }

  waitForReleaseBoundary(): Promise<void> {
    if (this.mode !== 'starting' && this.mode !== 'active') {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const boundary: ReleaseBoundary = { kind: 'boundary', resolve };
      if (this.mode === 'starting') {
        this.startupQueue.push(boundary);
        return;
      }
      this.pending.push(boundary);
      this.flushReleased();
    });
  }

  private beginTurn(
    event: AgentEvent,
    identity: NonNullable<ReturnType<typeof getModerationIdentity>>,
  ): void {
    this.mode = 'starting';
    this.identity = identity;
    this.turnId = randomUUID();
    this.lastTurnEvent = event;
    this.startupQueue.push({ kind: 'event', event });
    this.startupAbort = new AbortController();
    this.startupTimer = setTimeout(() => this.failOpenStarting(), STARTUP_FAIL_OPEN_MS);
    void this.start(identity);
  }

  cancel(): boolean {
    if (this.mode === 'idle') return false;
    this.stream?.cancel();
    this.startupAbort?.abort();
    this.startupAbort = null;
    this.clearStartupTimer();
    this.mode = 'terminal';
    this.terminalKind = 'cancelled';
    this.resolveReleaseBoundaries();
    this.startupQueue = [];
    this.pending = [];
    this.releasedBySequence.clear();
    return true;
  }

  close(): void {
    this.stream?.cancel();
    this.reset();
  }

  private async start(identity: NonNullable<ReturnType<typeof getModerationIdentity>>): Promise<void> {
    const callbacks: StreamModerationCallbacks = {
      onRelease: (frame) => this.onRelease(frame.sequence, frame.text),
      onBlock: () => this.onBlock(),
      onFailed: () => this.onFailed(),
      onCompleted: () => this.onCompleted(),
      onFailOpen: () => this.onFailOpen(),
    };
    const createStream = this.options.createStream ?? StreamModerationClient.create;
    let stream: StreamModerationClient | null = null;
    try {
      stream = await createStream({
        signBaseUrl: identity.signBaseUrl,
        accessToken: identity.accessToken,
        membershipId: identity.membershipId,
        sessionId: this.options.sessionId,
        turnId: this.turnId,
        agentKind: this.options.agentKind,
        signal: this.startupAbort?.signal,
      }, callbacks);
    } catch {
      stream = null;
    }
    if (this.mode !== 'starting') {
      stream?.cancel();
      return;
    }
    this.clearStartupTimer();
    this.startupAbort = null;
    if (!isModerationIdentityCurrent(identity)) {
      stream?.cancel();
      this.cancelForIdentityChange();
      return;
    }
    const queued = this.startupQueue;
    this.startupQueue = [];
    if (!stream) {
      this.mode = 'fail-open';
      for (const entry of queued) {
        if (entry.kind === 'boundary') entry.resolve();
        else this.deliverFailOpen(entry.event);
      }
      return;
    }
    this.stream = stream;
    this.mode = 'active';
    for (const entry of queued) {
      if (entry.kind === 'boundary') {
        this.pending.push(entry);
        this.flushReleased();
      } else {
        this.handleActive(entry.event);
      }
    }
  }

  private failOpenStarting(): void {
    if (this.mode !== 'starting') return;
    const queued = this.startupQueue;
    this.startupQueue = [];
    this.mode = 'fail-open';
    this.startupAbort?.abort();
    this.startupAbort = null;
    this.stream?.cancel();
    this.stream = null;
    for (const entry of queued) {
      if (entry.kind === 'boundary') entry.resolve();
      else this.deliverFailOpen(entry.event);
    }
  }

  private handleActive(event: AgentEvent): void {
    const text = textEvent(event);
    if (text) {
      if (!text.isFinal) {
        this.enqueueText(event, text.text);
        this.currentBlockSubmittedText += text.text;
        return;
      }
      if (this.currentBlockSubmittedText.length > 0) {
        const suffix = text.text.startsWith(this.currentBlockSubmittedText)
          ? text.text.slice(this.currentBlockSubmittedText.length)
          : '';
        if (suffix) this.enqueueText(withText(event, suffix, false), suffix);
        this.pending.push({
          kind: 'event',
          event,
          terminalBarrier: false,
        });
        this.currentBlockSubmittedText = '';
        this.flushReleased();
        return;
      }
      this.enqueueText(event, text.text);
      return;
    }

    this.pending.push({
      kind: 'event',
      event,
      terminalBarrier: event.type === 'done'
        || terminalError(event)
        || isRunningStatus(event, false),
    });
    if (event.type === 'tool_use') this.currentBlockSubmittedText = '';
    if ((event.type === 'done' || terminalError(event)) && !this.finishSent) {
      this.finishSent = true;
      this.stream?.finish();
    }
    this.flushReleased();
  }

  private enqueueText(event: AgentEvent, text: string): void {
    const sequence = this.stream?.push(text) ?? -1;
    if (sequence >= 0) this.pending.push({ kind: 'text', sequence, event });
  }

  private onRelease(sequence: number, text: string): void {
    if (this.mode !== 'active' || !this.identity) return;
    if (!isModerationIdentityCurrent(this.identity)) {
      this.cancelForIdentityChange();
      return;
    }
    this.releasedBySequence.set(sequence, text);
    this.flushReleased();
  }

  private flushReleased(): void {
    while (this.pending.length > 0) {
      const entry = this.pending[0];
      if (entry.kind === 'text') {
        const released = this.releasedBySequence.get(entry.sequence);
        if (released === undefined) return;
        this.pending.shift();
        this.releasedBySequence.delete(entry.sequence);
        this.releasedText += released;
        this.releasedBlockText += released;
        this.options.deliver(withText(entry.event, released));
        if (textEvent(entry.event)?.isFinal) this.releasedBlockText = '';
        continue;
      }
      if (entry.kind === 'boundary') {
        this.pending.shift();
        entry.resolve();
        continue;
      }
      if (entry.terminalBarrier && !this.completionApproved) return;
      this.pending.shift();
      const text = textEvent(entry.event);
      if (text?.isFinal) {
        this.options.deliver(withText(entry.event, this.releasedBlockText, true));
        this.releasedBlockText = '';
      } else {
        this.options.deliver(this.sanitizeReleasedResult(entry.event));
        if (entry.event.type === 'tool_use') this.releasedBlockText = '';
      }
    }
  }

  private sanitizeReleasedResult(event: AgentEvent): AgentEvent {
    if (event.type !== 'done' || !event.data || typeof event.data !== 'object') return event;
    return {
      ...event,
      data: { ...event.data, result: this.releasedText },
    } as AgentEvent;
  }

  private deliverFailOpen(event: AgentEvent): void {
    const text = textEvent(event);
    if (text) {
      if (!text.isFinal) {
        this.currentBlockSubmittedText += text.text;
        this.releasedText += text.text;
        this.options.deliver(event);
        return;
      }
      if (this.currentBlockSubmittedText.length > 0) {
        const suffix = text.text.startsWith(this.currentBlockSubmittedText)
          ? text.text.slice(this.currentBlockSubmittedText.length)
          : '';
        if (suffix) {
          this.releasedText += suffix;
          this.options.deliver(withText(event, suffix, false));
        }
        this.currentBlockSubmittedText = '';
        this.options.deliver(event);
        return;
      }
      this.releasedText += text.text;
      this.options.deliver(event);
      return;
    }
    this.options.deliver(this.sanitizeReleasedResult(event));
    if (event.type === 'done' || terminalError(event)) this.reset();
  }

  private onCompleted(): void {
    if (this.mode !== 'active' || !this.identity) return;
    if (!isModerationIdentityCurrent(this.identity)) {
      this.cancelForIdentityChange();
      return;
    }
    this.completionApproved = true;
    this.flushReleased();
    if (this.pending.length > 0) return;
    this.reset();
  }

  private onFailOpen(): void {
    if (this.mode !== 'active' || !this.identity) return;
    if (!isModerationIdentityCurrent(this.identity)) {
      this.cancelForIdentityChange();
      return;
    }
    this.completionApproved = true;
    this.flushReleased();
    if (this.finishSent && this.pending.length === 0) {
      this.reset();
      return;
    }
    this.mode = 'fail-open';
    this.stream = null;
  }

  private onBlock(): void {
    if (!this.enterExplicitTerminal('blocked')) return;
    this.options.onBlocked(this.turnId);
    this.options.deliver(this.syntheticDoneEvent());
    void this.options.abortTurn().catch(() => undefined);
  }

  private onFailed(): void {
    if (!this.enterExplicitTerminal('failed')) return;
    this.options.onFailed(this.turnId);
    this.options.deliver(this.syntheticFailureEvent());
    void this.options.abortTurn().catch(() => undefined);
  }

  private enterExplicitTerminal(kind: 'blocked' | 'failed'): boolean {
    if (this.mode !== 'active' || !this.identity) return false;
    if (!isModerationIdentityCurrent(this.identity)) {
      this.cancelForIdentityChange();
      return false;
    }
    this.mode = 'terminal';
    this.terminalKind = kind;
    this.resolveReleaseBoundaries();
    this.pending = [];
    this.releasedBySequence.clear();
    return true;
  }

  private syntheticDoneEvent(): AgentEvent {
    const result = this.releasedText.length > 0
      ? `${this.releasedText}\n\n${CONTENT_MODERATION_BLOCKED_MESSAGE}`
      : CONTENT_MODERATION_BLOCKED_MESSAGE;
    return {
      type: 'done',
      data: {
        result,
        contentModerationBlocked: true,
      },
      ...this.turnMetadata(),
    };
  }

  private syntheticFailureEvent(): AgentEvent {
    return {
      type: 'error',
      data: {
        message: 'Content generation failed',
        reason: 'turn-failed',
        contentModerationFailed: true,
        isTerminal: true,
      },
      ...this.turnMetadata(),
    };
  }

  private turnMetadata(): Pick<AgentEvent, 'source' | 'turnOrigin' | 'agentMeta'> {
    const event = this.lastTurnEvent;
    return {
      ...(event?.source ? { source: event.source } : {}),
      ...(event?.turnOrigin ? { turnOrigin: event.turnOrigin } : {}),
      ...(event?.agentMeta ? { agentMeta: event.agentMeta } : {}),
    };
  }

  private handleTerminal(event: AgentEvent): void {
    if (isRunningStatus(event, true)) {
      if (
        !this.terminalSettleDelivered
        && (this.terminalKind === 'cancelled' || this.terminalKind === 'identity-changed')
      ) {
        this.terminalSettleDelivered = true;
        this.options.deliver({
          type: 'done',
          data: { result: this.releasedText, cancelled: true },
          ...this.turnMetadata(),
        });
      }
      this.reset();
      this.handle(event);
      return;
    }
    if (
      this.terminalSettleDelivered
      || (this.terminalKind !== 'cancelled' && this.terminalKind !== 'identity-changed')
    ) {
      return;
    }
    if (isRunningStatus(event, false)) {
      this.options.deliver(event);
    } else if (event.type === 'done') {
      this.terminalSettleDelivered = true;
      this.options.deliver(this.sanitizeReleasedResult(event));
    } else if (terminalError(event)) {
      this.terminalSettleDelivered = true;
      this.options.deliver({
        type: 'done',
        data: { result: this.releasedText, cancelled: true },
        ...this.turnMetadata(),
      });
    }
  }

  private cancelForIdentityChange(): void {
    this.stream?.cancel();
    this.startupAbort?.abort();
    this.startupAbort = null;
    this.clearStartupTimer();
    this.mode = 'terminal';
    this.terminalKind = 'identity-changed';
    this.resolveReleaseBoundaries();
    this.startupQueue = [];
    this.pending = [];
    this.releasedBySequence.clear();
    void this.options.abortTurn().catch(() => undefined);
  }

  private clearStartupTimer(): void {
    if (!this.startupTimer) return;
    clearTimeout(this.startupTimer);
    this.startupTimer = null;
  }

  private resolveReleaseBoundaries(): void {
    for (const entry of this.startupQueue) {
      if (entry.kind === 'boundary') entry.resolve();
    }
    for (const entry of this.pending) {
      if (entry.kind === 'boundary') entry.resolve();
    }
  }

  private reset(): void {
    this.stream?.cancel();
    this.startupAbort?.abort();
    this.startupAbort = null;
    this.clearStartupTimer();
    this.resolveReleaseBoundaries();
    this.mode = 'idle';
    this.terminalKind = null;
    this.identity = null;
    this.stream = null;
    this.startupQueue = [];
    this.pending = [];
    this.releasedBySequence.clear();
    this.currentBlockSubmittedText = '';
    this.releasedBlockText = '';
    this.releasedText = '';
    this.turnId = '';
    this.finishSent = false;
    this.completionApproved = false;
    this.lastTurnEvent = null;
    this.terminalSettleDelivered = false;
  }
}
