export interface OfflinePushQueueItem {
  channel: string;
  payload: unknown;
  /** The topic that controls whether this item may be replayed. */
  topic: string;
}

interface QueuedPush extends OfflinePushQueueItem {
  queuedAt: number;
  bytes: number;
}

export interface OfflinePushQueueOptions {
  maxItems?: number;
  maxBytes?: number;
  ttlMs?: number;
  now?: () => number;
  estimateBytes?: (item: OfflinePushQueueItem) => number;
}

export interface OfflinePushQueue {
  enqueue(deviceId: string, item: OfflinePushQueueItem): void;
  drain(deviceId: string, topics?: readonly string[]): OfflinePushQueueItem[];
  snapshot(deviceId: string): OfflinePushQueueItem[];
  clear(deviceId?: string): void;
  size(deviceId: string): number;
}

const DEFAULT_MAX_ITEMS = 128;
const DEFAULT_MAX_BYTES = 512 * 1024;
const DEFAULT_TTL_MS = 5 * 60 * 1000;
const LEGACY_TOPIC = '*';
const STATE_COALESCE_CHANNELS: ReadonlySet<string> = new Set([
  'maker:status-changed',
  'maker:input:projection',
  'maker:goal:status-changed',
]);

function defaultEstimateBytes(item: OfflinePushQueueItem): number {
  try {
    return Buffer.byteLength(JSON.stringify(item), 'utf8');
  } catch {
    return 0;
  }
}

/**
 * 被控端到单个控制端的短时断线 push 补发队列。只在进程内保存、按设备隔离并严格限量；
 * 断线超过 TTL 或进程退出后仍需由权威 snapshot 补齐，不能把本队列当持久真相。
 */
export function createOfflinePushQueue(options: OfflinePushQueueOptions = {}): OfflinePushQueue {
  const maxItems = options.maxItems ?? DEFAULT_MAX_ITEMS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now ?? Date.now;
  const estimateBytes = options.estimateBytes ?? defaultEstimateBytes;
  const byDevice = new Map<string, QueuedPush[]>();

  const prune = (deviceId: string): QueuedPush[] => {
    const cutoff = now() - ttlMs;
    const current = (byDevice.get(deviceId) ?? []).filter((item) => item.queuedAt >= cutoff);
    if (current.length === 0) byDevice.delete(deviceId);
    else byDevice.set(deviceId, current);
    return current;
  };

  return {
    enqueue(deviceId, item): void {
      const bytes = Math.max(0, estimateBytes(item));
      if (!deviceId || !item.topic || bytes === 0 || bytes > maxBytes) return;
      const queue = prune(deviceId);
      // 只有明确列出的状态型 channel 才保留最新值；事件型 push 必须按顺序追加。
      if (STATE_COALESCE_CHANNELS.has(item.channel)) {
        const sessionId = typeof item.payload === 'object' && item.payload !== null
          ? (item.payload as { sessionId?: unknown }).sessionId
          : undefined;
        if (typeof sessionId === 'string' && sessionId) {
          const duplicateIndex = queue.findIndex((queued) => {
            if (
              queued.channel !== item.channel
              || queued.topic !== item.topic
              || typeof queued.payload !== 'object'
              || queued.payload === null
            ) return false;
            return (queued.payload as { sessionId?: unknown }).sessionId === sessionId;
          });
          if (duplicateIndex >= 0) queue.splice(duplicateIndex, 1);
        }
      }
      queue.push({ ...item, queuedAt: now(), bytes });
      let totalBytes = queue.reduce((sum, queued) => sum + queued.bytes, 0);
      while (queue.length > maxItems || totalBytes > maxBytes) {
        totalBytes -= queue.shift()?.bytes ?? 0;
      }
      if (queue.length > 0) byDevice.set(deviceId, queue);
      else byDevice.delete(deviceId);
    },
    drain(deviceId, topics): OfflinePushQueueItem[] {
      const queue = prune(deviceId);
      if (!topics || topics.includes(LEGACY_TOPIC)) {
        byDevice.delete(deviceId);
        return queue.map(({ channel, payload, topic }) => ({ channel, payload, topic }));
      }
      const allowed = new Set(topics);
      const selected = queue.filter((item) => allowed.has(item.topic));
      const remaining = queue.filter((item) => !allowed.has(item.topic));
      if (remaining.length > 0) byDevice.set(deviceId, remaining);
      else byDevice.delete(deviceId);
      return selected.map(({ channel, payload, topic }) => ({ channel, payload, topic }));
    },
    snapshot(deviceId): OfflinePushQueueItem[] {
      return prune(deviceId).map(({ channel, payload, topic }) => ({ channel, payload, topic }));
    },
    clear(deviceId): void {
      if (deviceId) byDevice.delete(deviceId);
      else byDevice.clear();
    },
    size(deviceId): number {
      return prune(deviceId).length;
    },
  };
}
