/**
 * Shared in-memory doubles for the approval inbox tests: a fake makerChatStore that mirrors the
 * real store's observable contract (stable light snapshots, `submitting` set synchronously by
 * respondToPermission, the card cleared only when the test delivers the host receipt), a fake
 * transport and an English translator backed by the real locale file so missing keys fail loudly.
 */
import { act } from '@testing-library/react';
import { vi } from 'vitest';

import en from '../../../i18n/locales/en/common.json';

export interface FakePermission {
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
  description?: string;
  suggestions?: unknown[];
  submitting?: boolean;
  submissionFailed?: boolean;
}
interface Light { pendingPermission: FakePermission | null }
const EMPTY: Light = { pendingPermission: null };

export const fake = {
  statuses: new Map<string, { hasPendingPermission: boolean }>(),
  lights: new Map<string, Light>(),
  listeners: new Set<() => void>(),
  activities: new Map<string, { phase: string; interactionKind?: string }>(),
  respond: vi.fn(),
  reconcile: vi.fn(),
  getSessionFor: vi.fn(),
  sessions: new Map<string, Record<string, unknown>>(),
  teams: new Map<string, { leadSessionId: string } | null>(),
  workers: new Map<string, Array<Record<string, unknown>>>(),
  getByWorkerSession: vi.fn(),
  listWorkersByLead: vi.fn(),
  projectLabel: vi.fn(),
  resolveSessionRoute: vi.fn(),
  layout: { width: 1000 },
};

export const store = {
  subscribeAll: (fn: () => void) => { fake.listeners.add(fn); return () => { fake.listeners.delete(fn); }; },
  getRunningSnapshot: () => fake.statuses,
  subscribeLight: (_id: string, fn: () => void) => { fake.listeners.add(fn); return () => { fake.listeners.delete(fn); }; },
  getLightSnapshot: (id: string) => fake.lights.get(id) ?? EMPTY,
  respondToPermission: (id: string, result: unknown) => {
    fake.respond(id, result);
    const light = fake.lights.get(id);
    if (!light?.pendingPermission || light.pendingPermission.submitting) return;
    fake.lights.set(id, { pendingPermission: { ...light.pendingPermission, submitting: true } });
    publish();
  },
  reconcilePendingInteractions: (id: string) => fake.reconcile(id),
};

export const transport = {
  getSessionFor: (id: string) => fake.getSessionFor(id),
  orcaWorkflowsFor: () => ({
    getByWorkerSession: (id: string) => fake.getByWorkerSession(id),
    listWorkersByLead: (id: string) => fake.listWorkersByLead(id),
  }),
};

export function subscribe(fn: () => void): () => void {
  fake.listeners.add(fn);
  return () => { fake.listeners.delete(fn); };
}

export function setActivities(next: typeof fake.activities): void {
  fake.activities = next;
  publish();
}

export function publish(): void {
  act(() => { for (const listener of [...fake.listeners]) listener(); });
}

export function addRequest(
  sessionId: string,
  requestId = 'req-' + sessionId,
  extra: Partial<FakePermission> = {},
): void {
  fake.statuses = new Map(fake.statuses).set(sessionId, { hasPendingPermission: true });
  fake.lights.set(sessionId, { pendingPermission: {
    requestId, toolName: 'Bash', input: { command: 'echo secret-' + sessionId }, ...extra,
  } });
}

/** The host receipt / dismissal: the store clears the card and the running flag. */
export function clearRequest(sessionId: string): void {
  const next = new Map(fake.statuses);
  next.delete(sessionId);
  fake.statuses = next;
  fake.lights.set(sessionId, { pendingPermission: null });
}

export function resetFake(): void {
  fake.statuses = new Map();
  fake.lights = new Map();
  fake.listeners.clear();
  fake.activities = new Map();
  fake.sessions = new Map();
  fake.teams = new Map();
  fake.workers = new Map();
  fake.layout.width = 1000;
  fake.respond.mockReset();
  fake.reconcile.mockReset().mockResolvedValue(0);
  fake.getSessionFor.mockReset().mockImplementation(async (id: string) =>
    fake.sessions.get(id) ?? { id, title: 'Session ' + id, workingDir: '/project/' + id });
  fake.getByWorkerSession.mockReset().mockImplementation(async (id: string) => fake.teams.get(id) ?? null);
  fake.listWorkersByLead.mockReset().mockImplementation(async (id: string) => fake.workers.get(id) ?? []);
  fake.projectLabel.mockReset().mockResolvedValue(null);
  fake.resolveSessionRoute.mockReset().mockImplementation(async (id: string) => '/cc-agent/' + id);
}

// ── English translator over the real locale file ─────────────────────────────────────────────
export function t(key: string, args?: Record<string, unknown>): string {
  const value = key.split('.').reduce<unknown>(
    (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
    en,
  );
  if (typeof value !== 'string') return 'MISSING:' + key;
  return value.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => String(args?.[name] ?? ''));
}

// ── Layout doubles (jsdom has no layout) ─────────────────────────────────────────────────────
export function installLayout(): () => void {
  const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({
    width: fake.layout.width, height: 600, top: 0, left: 0, right: fake.layout.width, bottom: 600, x: 0, y: 0,
    toJSON: () => ({}),
  }));
  class StubResizeObserver {
    constructor(private readonly cb: ResizeObserverCallback) {}
    observe(): void {
      this.cb([{ contentRect: { width: fake.layout.width } } as ResizeObserverEntry], this as unknown as ResizeObserver);
    }
    unobserve(): void {}
    disconnect(): void {}
  }
  vi.stubGlobal('ResizeObserver', StubResizeObserver);
  return () => { rect.mockRestore(); vi.unstubAllGlobals(); };
}

/** Flush resolved promises without moving the fake clock. */
export async function flush(times = 3): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  }
}
export async function advance(ms: number): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}
