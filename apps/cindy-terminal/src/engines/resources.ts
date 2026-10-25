import { randomUUID } from 'node:crypto';
import type { RemoteResource, RemoteResourceRegistry, RemoteLocalizedText } from '@cindy/device-link';
import { getMessages, type Locale } from '../ui/i18n.js';
import type { EngineManager } from './manager.js';
import type { EngineKind, EngineStatus } from './types.js';

export type EngineOperation = 'install' | 'update' | 'repair';
export interface EngineJob { id: string; operation: EngineOperation; state: 'running' | 'completed' | 'failed'; error?: string }
export interface EngineResourceState extends EngineStatus { job?: EngineJob }
const kinds: EngineKind[] = ['claude-code', 'codex', 'pi'];
const titles = { 'claude-code': 'Claude Code', codex: 'Codex', pi: 'Pi' };
function text(key: 'engines' | 'install' | 'update' | 'repair' | 'notInstalled' | 'working' | 'error'): RemoteLocalizedText {
  const locales: Locale[] = ['en', 'zh-CN', 'zh-TW', 'ja', 'ko'];
  return { fallback: getMessages('en')[key], translations: Object.fromEntries(locales.map(locale => [locale, getMessages(locale)[key]])) };
}

/** Installs belong to the selected host. A short resource request starts a job;
 * downloads survive controller disconnects, but never an account transition. */
export class TerminalEngineResources {
  private readonly jobs = new Map<EngineKind, EngineJob>();
  private readonly pending = new Set<Promise<void>>();
  private readonly controller = new AbortController();
  private readonly unregister: () => void;
  constructor(registry: RemoteResourceRegistry, private readonly options: {
    engines: Pick<EngineManager, 'allStatus' | 'status' | 'install' | 'update' | 'repair'>;
    assertCurrent(): void;
    refresh(status: EngineStatus): Promise<void>;
    changed(): void;
  }) {
    this.unregister = registry.register({
      collection: { id: 'engines', resourceKind: 'engine', title: text('engines'), placement: 'settings' },
      list: async context => {
        this.assertCurrent(); context.assertCurrent?.();
        const statuses = await options.engines.allStatus();
        this.assertCurrent(); context.assertCurrent?.();
        const items = statuses.map(status => this.resource(status));
        return { collectionId: 'engines', revision: JSON.stringify(items.map(item => item.revision)), items };
      },
      get: async (context, request) => {
        this.assertCurrent(); context.assertCurrent?.();
        const status = await options.engines.status(this.kind(request.ref.id));
        this.assertCurrent(); context.assertCurrent?.();
        return this.resource(status);
      },
      invoke: async (context, request) => {
        this.assertCurrent(); context.assertCurrent?.();
        const kind = this.kind(request.resourceRef?.id);
        if (!['install', 'update', 'repair'].includes(request.actionId)) throw new Error('INVALID_ACTION');
        const operation = request.actionId as EngineOperation;
        const previous = this.jobs.get(kind);
        if (previous?.state === 'running') throw new Error('ENGINE_OPERATION_IN_PROGRESS');
        const job: EngineJob = { id: randomUUID(), operation, state: 'running' };
        this.jobs.set(kind, job);
        const work = this.run(kind, job);
        this.pending.add(work);
        void work.finally(() => this.pending.delete(work));
        return { effects: [{ kind: 'refresh-collection', collectionId: 'engines' }], result: { ...job } };
      },
    });
  }
  private assertCurrent() { this.controller.signal.throwIfAborted(); this.options.assertCurrent(); }
  private kind(value: unknown): EngineKind {
    if (!kinds.includes(value as EngineKind)) throw new Error('INVALID_ENGINE');
    return value as EngineKind;
  }
  private resource(status: EngineStatus): RemoteResource {
    const job = this.jobs.get(status.kind), busy = job?.state === 'running';
    const state: EngineResourceState = { ...status, ...(job ? { job: { ...job } } : {}) };
    return {
      ref: { collectionId: 'engines', kind: 'engine', id: status.kind }, revision: JSON.stringify(state), links: [],
      display: { title: titles[status.kind], subtitle: status.version ?? text('notInstalled'),
        ...(busy ? { status: { label: text('working') } } : job?.error ? { status: { label: text('error'), tone: 'critical' } } : {}) },
      actions: (['install', 'update', 'repair'] as const).map(id => ({ id, label: text(id), disabled: busy })),
      blocks: [{ id: 'engine', primitive: 'engine-status', fallbackMarkdown: [status.version ?? '', status.binary ?? '', job?.error ?? ''].filter(Boolean).join('\n'), data: state }],
    };
  }
  private async run(kind: EngineKind, job: EngineJob): Promise<void> {
    try {
      this.assertCurrent();
      const { engines } = this.options, signal = this.controller.signal;
      const result = job.operation === 'install' ? await engines.install(kind, { signal }) : await engines[job.operation](kind, signal);
      this.assertCurrent();
      await this.options.refresh(result);
      this.assertCurrent(); job.state = 'completed';
    } catch (error) {
      job.state = 'failed';
      const code = error instanceof Error ? error.message : '';
      job.error = /^(?:engine_|invalid_|unsafe_)[a-z_]+$/.test(code) ? code : 'ENGINE_OPERATION_FAILED';
    } finally {
      try { this.assertCurrent(); this.options.changed(); } catch { /* Old owner cannot publish into the next account. */ }
    }
  }
  async close() {
    this.unregister(); this.controller.abort();
    await Promise.allSettled(this.pending);
  }
}
