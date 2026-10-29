/**
 * In-memory stand-in for makerChatStore. It mirrors the real contract the inbox depends on: stable
 * light snapshots, respondToPermission sets `submitting` synchronously and the card is cleared only
 * when the (simulated) host receipt arrives. `window.__approvalStore` lets check() change the queue
 * and read the decisions that reached respondToPermission.
 */
import { ALL, REQUESTS } from './data';

declare global {
  interface Window {
    __approvalStore: {
      log: Array<{ sessionId: string; result: unknown }>;
      add: (sessionId: string) => void;
      remove: (sessionId: string) => void;
    };
  }
}

const scenario = (window as unknown as { __uiPage: { ctx: { case: string } } }).__uiPage.ctx.case;
const listeners = new Set<() => void>();
const EMPTY = { pendingPermission: null };

let statuses = new Map<string, { hasPendingPermission: boolean }>();
const lights = new Map<string, { pendingPermission: Record<string, unknown> | null }>();
const log: Array<{ sessionId: string; result: unknown }> = [];

const emit = () => { for (const listener of [...listeners]) listener(); };

function add(sessionId: string): void {
  const request = ALL.find((item) => item.sessionId === sessionId)!;
  statuses = new Map(statuses).set(sessionId, { hasPendingPermission: true });
  lights.set(sessionId, { pendingPermission: {
    requestId: request.requestId, toolName: request.toolName, input: request.input,
    description: request.description, autoReviewReason: request.autoReviewReason, suggestions: request.suggestions,
    submitting: scenario === 'submitting' && sessionId === 's-frontend',
    submissionFailed: scenario === 'failed' && sessionId === 's-frontend',
  } });
  emit();
}

function remove(sessionId: string): void {
  const next = new Map(statuses);
  next.delete(sessionId);
  statuses = next;
  lights.set(sessionId, { pendingPermission: null });
  emit();
}

if (scenario !== 'empty') for (const request of REQUESTS) add(request.sessionId);
window.__approvalStore = { log, add, remove };

export const makerChatStore = {
  subscribeAll: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  getRunningSnapshot: () => statuses,
  subscribeLight: (_id: string, listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  getLightSnapshot: (id: string) => lights.get(id) ?? EMPTY,
  reconcilePendingInteractions: async () => 0,
  respondToPermission: (sessionId: string, result: unknown) => {
    const light = lights.get(sessionId);
    if (!light?.pendingPermission || light.pendingPermission.submitting) return;
    log.push({ sessionId, result });
    lights.set(sessionId, { pendingPermission: { ...light.pendingPermission, submitting: true } });
    emit();
    setTimeout(() => remove(sessionId), 450);
  },
};
