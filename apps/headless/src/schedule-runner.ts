import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FireContext, FireResult, Schedule, ScheduleRunner } from '@cindy/maker-scheduler';
import type { HeadlessSessionEvent, HeadlessSessionEventSource, HeadlessSessionEventStorage, HeadlessSessionMeta, HeadlessSessionStorageContract } from './session-types.js';
import type { HeadlessSessionRuntime } from './session-runtime.js';
import type { HeadlessScheduleStorage } from './schedule-storage.js';

type ScheduleSessionStorage = HeadlessSessionStorageContract & HeadlessSessionEventStorage & HeadlessSessionEventSource;

/** Runs a schedule through the same durable session runtime used by CLI/mobile. */
export class HeadlessScheduleRunner implements ScheduleRunner {
  constructor(
    private readonly storage: ScheduleSessionStorage,
    private readonly runtime: HeadlessSessionRuntime,
    private readonly stateDir: string,
    private readonly scheduleStorage?: HeadlessScheduleStorage,
  ) {}

  async fire(schedule: Schedule, context: FireContext): Promise<FireResult> {
    const session = await this.resolveSession(schedule);
    if (this.runtime.isSessionBusy(session.id)) return { sessionId: session.id, deferred: true, deferRetryMs: 60_000 };
    await context.onSessionBound?.(session.id);
    const afterSequence = await lastSequence(this.storage, session.id);
    const terminal = waitForTerminal(this.storage, session.id, afterSequence, context.signal, () => this.runtime.abort(session.id));
    try {
      await this.runtime.send(session, schedule.prompt, { kind: 'scheduler', scheduleId: schedule.id, scheduleName: schedule.name, runId: context.runId });
      context.onTurnActive?.(session.id);
      const result = await terminal;
      if (result.error) throw new Error(result.error);
      return { sessionId: session.id, resultText: result.text || undefined };
    } catch (error) {
      terminal.cancel();
      throw error;
    }
  }

  private async resolveSession(schedule: Schedule): Promise<HeadlessSessionMeta> {
    if (schedule.targetSessionId) {
      const existing = await this.storage.get(schedule.targetSessionId);
      if (existing) return existing;
      if (!schedule.persistentSession) throw new Error(`Scheduled session no longer exists: ${schedule.targetSessionId}`);
    }
    const id = randomUUID();
    const workDir = schedule.workspaceKind === 'dialogue'
      ? await this.createDialogueWorkdir(id)
      : schedule.workingDir;
    if (!workDir) throw new Error('A project schedule requires workingDir');
    const session = await this.storage.create({
      id,
      agentKind: schedule.agentKind,
      providerId: schedule.providerId,
      workDir,
      workspaceKind: schedule.workspaceKind,
      title: `[Schedule] ${schedule.name}`,
      model: schedule.model ?? 'default',
      effort: validEffort(schedule.effort),
      permissionMode: 'ask',
      fastMode: schedule.fastMode === true,
    });
    await this.storage.appendEvent(id, 'session_created', { session, origin: { kind: 'scheduler', scheduleId: schedule.id } });
    if (schedule.persistentSession) await this.scheduleStorage?.update(schedule.id, { targetSessionId: id });
    return session;
  }

  private async createDialogueWorkdir(id: string): Promise<string> {
    const dir = path.join(this.stateDir, 'dialogue-workspaces', id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    return dir;
  }
}

function validEffort(value: string | undefined): HeadlessSessionMeta['effort'] {
  return value === 'minimal' || value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh' || value === 'max' || value === 'ultra'
    ? value
    : undefined;
}

async function lastSequence(storage: HeadlessSessionEventStorage, sessionId: string): Promise<number> {
  const events = await storage.listEvents(sessionId, 0, 1_000);
  return events.at(-1)?.sequence ?? 0;
}

function waitForTerminal(
  storage: ScheduleSessionStorage,
  sessionId: string,
  afterSequence: number,
  signal: AbortSignal,
  abort: () => Promise<void>,
): { then: Promise<{ text: string; error?: string }>['then']; cancel: () => void } & PromiseLike<{ text: string; error?: string }> {
  let stop: () => void = () => undefined;
  let abortListener: () => void = () => undefined;
  let settled = false;
  let resolvePromise!: (value: { text: string; error?: string }) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const text: string[] = [];
  const promise = new Promise<{ text: string; error?: string }>((resolve, reject) => { resolvePromise = resolve; rejectPromise = reject; });
  const finish = (value: { text: string; error?: string }) => {
    if (settled) return;
    settled = true;
    stop();
    signal.removeEventListener('abort', abortListener);
    resolvePromise(value);
  };
  const consume = (event: HeadlessSessionEvent) => {
    if (event.sessionId !== sessionId || event.sequence <= afterSequence || event.type !== 'agent_event') return;
    const agent = event.data && typeof event.data === 'object' ? event.data as Record<string, unknown> : null;
    if (!agent) return;
    if (agent.type === 'text' && typeof agent.data === 'string') text.push(agent.data);
    if (agent.type === 'done') finish({ text: text.join('') });
    if (agent.type === 'error' && isTerminalError(agent.data)) {
      const data = agent.data && typeof agent.data === 'object' ? agent.data as { message?: unknown } : {};
      finish({ text: text.join(''), error: typeof data.message === 'string' ? data.message : 'Scheduled turn failed' });
    }
  };
  stop = storage.onEvent(consume);
  abortListener = () => {
    void abort().catch(() => undefined).finally(() => {
      if (!settled) {
        settled = true;
        stop();
        rejectPromise(new DOMException('Scheduled turn aborted', 'AbortError'));
      }
    });
  };
  signal.addEventListener('abort', abortListener, { once: true });
  if (signal.aborted) abortListener();
  return Object.assign(promise, { cancel: () => { if (!settled) { settled = true; stop(); signal.removeEventListener('abort', abortListener); rejectPromise(new Error('scheduled turn cancelled')); } } });
}

function isTerminalError(value: unknown): boolean {
  if (!value || typeof value !== 'object') return true;
  const data = value as { isTerminal?: unknown; willRetry?: unknown };
  return typeof data.isTerminal === 'boolean' ? data.isTerminal : typeof data.willRetry === 'boolean' ? !data.willRetry : true;
}
