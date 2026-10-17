import { randomUUID } from 'node:crypto';
import type { AgentCustomization, ListCustomizationsOptions, ListCustomizationsResult } from '@cindy/maker-core';
import type { CustomizationScanRequest, CustomizationScanResponse, EngineScanRequest } from './customizationScanProtocol';

export interface CustomizationScanChild {
  postMessage(message: CustomizationScanRequest): void;
  on(event: 'message', listener: (message: unknown) => void): void;
  on(event: 'exit', listener: (code: number) => void): void;
  on(event: 'error', listener: (type: string) => void): void;
  kill(): boolean;
}

interface ScanJob {
  result: Promise<unknown>;
  stop: () => void;
}

function isResult(value: unknown, engine: AgentCustomization['engine']): value is ListCustomizationsResult {
  if (!value || typeof value !== 'object') return false;
  const result = value as Partial<ListCustomizationsResult>;
  return Array.isArray(result.items) && result.items.every((item) =>
    item && item.engine === engine && typeof item.name === 'string' &&
    typeof item.kind === 'string' && typeof item.scope === 'string' &&
    typeof item.absolutePath === 'string',
  ) && Array.isArray(result.errors) && result.errors.every((error) =>
    error && typeof error.message === 'string' &&
    (error.path === undefined || typeof error.path === 'string'),
  );
}

/** Only discovery runs here. Main still owns managed Skills and all file-operation grants. */
export class CustomizationScanClient {
  private readonly jobs = new Map<string, ScanJob>();
  private disposed = false;
  // kill() requests termination; native I/O can delay the actual exit.
  private readonly children = new Set<CustomizationScanChild>();
  private readonly killRequested = new Set<CustomizationScanChild>();

  constructor(private readonly options: {
    fork: () => CustomizationScanChild;
    timeoutMs?: number;
    maxConcurrent?: number;
  }) {}

  async scan(engine: AgentCustomization['engine'], options: ListCustomizationsOptions): Promise<ListCustomizationsResult> {
    const failure = (message: string): ListCustomizationsResult => ({
      items: [], errors: [{ message: `[${engine}] ${message}` }],
    });
    return this.request<ListCustomizationsResult>({ kind: 'scan', engine, options },
      (value): value is ListCustomizationsResult => isResult(value, engine), failure);
  }

  async request<T>(
    task: Omit<EngineScanRequest, 'id'>
      | { kind: 'project'; input: import('./skillListProjection').SkillListProjectionInput }
      | { kind: 'grants'; input: import('./skillScanGrants').SkillScanGrantInput },
    validate: (value: unknown) => value is T,
    failure: (message: string) => T,
  ): Promise<T> {
    if (this.disposed) return failure('Customization scanner stopped');
    // YAML anchors may create cycles; the utility-process packet supports them.
    let key: string;
    try { key = JSON.stringify(task); } catch { key = randomUUID(); }
    const existing = this.jobs.get(key);
    // Agents append host-managed Skills. Never share their mutable result arrays.
    if (existing) return structuredClone(await existing.result) as T;
    if (this.children.size >= (this.options.maxConcurrent ?? 6)) {
      return failure('Customization scanner busy; retry after the pending scan');
    }

    let resolve!: (result: T) => void;
    const result = new Promise<T>((complete) => { resolve = complete; });
    let child: CustomizationScanChild | undefined;
    let settled = false;
    let exited = false;
    const finish = (value: T): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      this.jobs.delete(key);
      if (child && !exited) this.killChild(child);
      resolve(value);
    };
    // File approval can wait indefinitely inside native scandir/open. Main owns
    // the timer and kills the isolated process, rather than racing uncancellable
    // I/O on Main's event loop or its shared libuv pool.
    const timer = setTimeout(() => finish(failure('Customization scan timed out')), this.options.timeoutMs ?? 15_000);
    timer.unref?.();
    this.jobs.set(key, { result, stop: () => finish(failure('Customization scanner stopped')) });
    const id = randomUUID();
    try {
      child = this.options.fork();
      this.children.add(child);
      child.on('message', (value) => {
        if (!value || typeof value !== 'object') return;
        const response = value as Partial<CustomizationScanResponse>;
        if (response.kind !== 'result' || response.id !== id) return;
        finish(validate(response.result) ? response.result : failure('Customization scanner returned an invalid result'));
      });
      child.on('exit', () => {
        exited = true;
        this.children.delete(child!);
        this.killRequested.delete(child!);
        finish(failure('Customization scanner exited before completing'));
      });
      child.on('error', () => finish(failure('Customization scanner failed')));
      child.postMessage({ ...task, id });
    } catch {
      finish(failure('Could not start customization scanner'));
    }
    return structuredClone(await result);
  }

  private killChild(child: CustomizationScanChild): void {
    if (this.killRequested.has(child)) return;
    this.killRequested.add(child);
    try { child.kill(); } catch { /* Retain the slot until exit confirms cleanup. */ }
  }

  dispose(): void {
    this.disposed = true;
    for (const job of this.jobs.values()) job.stop();
    for (const child of this.children) this.killChild(child);
  }
}
