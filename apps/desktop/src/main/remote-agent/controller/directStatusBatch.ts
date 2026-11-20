import { REMOTE_AGENT_MAX_DIRECT_STATUS_BATCH, type RemoteAgentRequest } from '@cindy/device-link';

type Batch = Extract<RemoteAgentRequest, { op: 'direct-status-batch' }>;
type Source = { read(): boolean; current(): boolean; generation(): string | undefined };
type Status = Batch['statuses'][number];

/** One heartbeat and one in-flight report per share and permission generation. */
export function createDirectStatusBatcher(send: (owner: string, batch: Batch, beforeDispatch: () => void) => Promise<unknown>) {
  type Group = {
    sources: Map<string, Source>;
    pending: Map<string, { source: Source; status: Status }>;
    heartbeat: ReturnType<typeof setInterval>;
    flushTimer?: ReturnType<typeof setTimeout>;
    sending?: boolean;
  };
  const groups = new Map<string, Group>();

  return (owner: string, scope: string, sessionId: string, source: Source) => {
    const key = JSON.stringify([owner, scope]);
    const group = groups.get(key) ?? create();
    function schedule() {
      if (group.sending || group.flushTimer) return;
      group.flushTimer = setTimeout(flush, 50);
      group.flushTimer.unref?.();
    }
    function finish() {
      if (group.pending.size) schedule();
      else if (!group.sources.size && groups.get(key) === group) {
        clearInterval(group.heartbeat);
        groups.delete(key);
      }
    }
    function isUsable({ source, status }: { source: Source; status: Status }): boolean {
      const current = group.sources.get(status.sessionId);
      return (!current || current === source) && source.current() && source.generation() === status.generation;
    }
    function flush() {
      group.flushTimer = undefined;
      const rows: { source: Source; status: Status }[] = [];
      for (const [id, entry] of group.pending) {
        group.pending.delete(id);
        if (isUsable(entry)) rows.push(entry);
        if (rows.length === REMOTE_AGENT_MAX_DIRECT_STATUS_BATCH) break;
      }
      if (!rows.length) { finish(); return; }
      group.sending = true;
      const statuses = rows.map(row => row.status);
      const beforeDispatch = () => {
        if (!rows.every(isUsable)) {
          for (const entry of rows) {
            if (isUsable(entry) && !group.pending.has(entry.status.sessionId)) {
              enqueue(entry.status.sessionId, entry.source, entry.status.running);
            }
          }
          throw new Error('Shared status is no longer current');
        }
      };
      void send(owner, { op: 'direct-status-batch', statuses }, beforeDispatch).catch(() => undefined).finally(() => {
        group.sending = false;
        finish();
      });
    }
    function create(): Group {
      const value: Group = { sources: new Map(), pending: new Map(), heartbeat: setInterval(() => {
        for (const [id, active] of value.sources) enqueue(id, active, active.read());
        if (value.pending.size) schedule();
      }, 30_000) };
      value.heartbeat.unref?.();
      groups.set(key, value);
      return value;
    }

    group.sources.set(sessionId, source);
    group.pending.delete(sessionId);
    function enqueue(id: string, active: Source, running: boolean) {
      const generation = active.generation();
      if (!generation || !active.current()) return;
      group.pending.set(id, { source: active, status: { sessionId: id, running, generation } });
      if (group.pending.size > 512) group.pending.delete(group.pending.keys().next().value!);
    }
    const report = (running: boolean) => {
      if (group.sources.get(sessionId) !== source) return;
      enqueue(sessionId, source, running);
      schedule();
    };
    return { report, close() {
      if (group.sources.get(sessionId) !== source) return;
      report(false);
      group.sources.delete(sessionId);
      if (!group.sending && !group.flushTimer) finish();
    } };
  };
}
