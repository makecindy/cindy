import type { RemoteInvoke } from '@/device-link/mobileMakerTransport';

type Read = {
  id: string;
  current(): boolean;
  resolve(value: unknown): void;
  reject(error: unknown): void;
};
const queues = new Map<string, Read[]>();
const refreshes = new Map<string, { listeners: Set<() => void>; timer: ReturnType<typeof setInterval> }>();

function permitsSingleRead(error: unknown): boolean {
  const record = error && typeof error === 'object' ? error as { code?: unknown; message?: unknown } : {};
  const message = typeof record.message === 'string' ? record.message : String(error);
  const code = typeof record.code === 'string' && record.code !== 'IPC_ERROR'
    ? record.code : /^\[([^\]]+)\]/.exec(message)?.[1];
  return code === 'CHANNEL_NOT_ALLOWED' || code === 'DEVICE_LINK_CHANNEL_NOT_ALLOWED'
    || (code === 'PRECONDITION_FAILED' && message.replace(/^\[[^\]]+\]\s*/, '') === 'REMOTE_SESSION_BATCH_TOO_LARGE');
}

function isTask(value: unknown): value is { id: string; title: string } {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && typeof (value as { id?: unknown }).id === 'string'
    && typeof (value as { title?: unknown }).title === 'string';
}

async function readChunk(reads: Read[], deviceId: string, invoke: RemoteInvoke): Promise<void> {
  const ids = [...new Set(reads.map((read) => read.id))];
  try {
    let value: unknown;
    try {
      value = await invoke(deviceId, 'local-db:sessions:get-many', [ids]);
    } catch (error) {
      if (!permitsSingleRead(error)) throw error;
      // Old hosts / oversized batch replies only. Keep fallback serial, and do
      // not issue queued reads after focus, account or connection has changed.
      for (const id of ids) {
        const consumers = reads.filter((read) => read.id === id);
        if (!consumers.some((read) => read.current())) {
          consumers.forEach((read) => read.resolve(null));
          continue;
        }
        try {
          const row = await invoke(deviceId, 'local-db:sessions:get', [id]);
          if (row !== null && (!isTask(row) || row.id !== id)) throw new Error('Invalid task reply');
          consumers.forEach((read) => read.resolve(row));
        } catch (error) {
          consumers.forEach((read) => read.reject(error));
        }
      }
      return;
    }
    if (!Array.isArray(value) || value.some((row) => !isTask(row) || !ids.includes(row.id))
      || new Set(value.map((row) => row.id)).size !== value.length) throw new Error('Invalid task batch reply');
    const rows = new Map(value.map((row) => [row.id, row]));
    reads.forEach((read) => read.resolve(rows.get(read.id) ?? null));
  } catch (error) {
    // Timeout, revocation and malformed replies never multiply into single GETs.
    reads.forEach((read) => read.reject(error));
  }
}

/** One in-flight batch per account/connection/host; no completed-result cache. */
export function readCompanionTask(
  scope: string, deviceId: string, id: string, invoke: RemoteInvoke, current: () => boolean,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let queue = queues.get(scope);
    if (!queue) {
      queue = [];
      queues.set(scope, queue);
      const captured = queue;
      // Let cards mounted in the same render register before selecting a batch.
      void Promise.resolve().then(async () => {
        try {
          while (captured.length) {
            const reads = captured.splice(0, 8).filter((read) => {
              if (read.current()) return true;
              read.resolve(null);
              return false;
            });
            if (reads.length) await readChunk(reads, deviceId, invoke);
          }
        } finally {
          if (queues.get(scope) === captured) queues.delete(scope);
        }
      });
    }
    queue.push({ id, current, resolve, reject });
  });
}

/** Poll together so differently mounted cards do not create separate read waves. */
export function subscribeCompanionTaskRefresh(scope: string, intervalMs: number, load: () => void): () => void {
  const key = JSON.stringify([scope, intervalMs]);
  let entry = refreshes.get(key);
  if (!entry) {
    const listeners = new Set<() => void>();
    entry = { listeners, timer: setInterval(() => listeners.forEach((listener) => listener()), intervalMs) };
    refreshes.set(key, entry);
  }
  const captured = entry;
  captured.listeners.add(load);
  return () => {
    captured.listeners.delete(load);
    if (captured.listeners.size === 0) {
      clearInterval(captured.timer);
      refreshes.delete(key);
    }
  };
}
