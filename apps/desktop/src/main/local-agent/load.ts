/** Owner-scoped, in-memory application sessions, consumed by the ordinary group lease reporter. */
import type { Session } from '@cindy/maker-core';
import type { ProviderGroupBinding } from '../provider-group/bindings.js';
import type { LocalAgentExecutionRoute } from './groupRoute.js';

type LoadSession = Pick<Session, 'isTurnRunning' | 'onEvent' | 'onStatusChange'>;
export type LocalAgentLoadTracker = (id: string, route: LocalAgentExecutionRoute, session: LoadSession) => () => void;

export function createLocalAgentLoadRegistry() {
  const entries = new Map<string, { route: LocalAgentExecutionRoute; session: LoadSession; at: number; release(): void }>();
  const listeners = new Set<(id: string) => void>();
  const notify = (id: string) => { for (const listener of listeners) listener(id); };
  const track: LocalAgentLoadTracker = (id, route, session) => {
    entries.get(id)?.release();
    const entry = { route, session, at: Date.now(), release: () => {} };
    let lastRunning: boolean | undefined;
    const changed = () => {
      if (entries.get(id) !== entry) return;
      const running = session.isTurnRunning();
      // Token events must not continually postpone the shared reporter's heartbeat.
      if (running === lastRunning) return;
      lastRunning = running;
      notify(id);
    };
    const removeEvents = session.onEvent(changed);
    const removeStatus = session.onStatusChange((status) => {
      if (status === 'closed') entry.release();
      else changed();
    });
    entry.release = () => {
      removeEvents();
      removeStatus();
      if (entries.get(id) !== entry) return;
      entries.delete(id);
      notify(id);
    };
    entries.set(id, entry);
    changed();
    return changed;
  };
  return {
    track,
    subscribe(listener: (id: string) => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    bindings(): Record<string, ProviderGroupBinding> {
      return Object.fromEntries([...entries].flatMap(([id, entry]) => entry.route.groupBinding
        ? [[id, { ...entry.route.groupBinding, at: entry.at }]] : []));
    },
    isTurnRunning(id: string): boolean { return entries.get(id)?.session.isTurnRunning() ?? false; },
    runningProviders(): string[] {
      return [...entries.values()].filter(({ route, session }) => !route.agentDeviceId && session.isTurnRunning())
        .map(({ route }) => route.providerId);
    },
  };
}
