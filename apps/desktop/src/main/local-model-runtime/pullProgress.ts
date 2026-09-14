import {
  classifyOllamaPullStatus,
  type LocalModelPullProgress,
} from '../../shared/localModelRuntime.js';
import type { OllamaPullEvent } from './ollamaClient.js';

export interface PullLayer {
  completed: number;
  total: number;
}

const SPEED_WINDOW_MS = 3_000;
const SPEED_HOLD_MS = 1_500;
/** 单层一次跳这么多，当成续传入账，不计入下载速度。 */
const SPEED_RESUME_SPIKE_BYTES = 64 * 1024 * 1024;

export function createPullSpeedTracker(now: () => number = Date.now) {
  const samples: Array<{ at: number; transferred: number }> = [];
  const layerCompleted = new Map<string, number>();
  let transferred = 0;
  let lastSpeed: number | undefined;
  let lastSpeedAt = 0;
  return {
    update(layers: ReadonlyMap<string, PullLayer>): number | undefined {
      const at = now();
      let added = 0;
      for (const [digest, layer] of layers) {
        const previous = layerCompleted.get(digest) ?? 0;
        const next = layer.completed;
        if (next <= previous) continue;
        const delta = next - previous;
        layerCompleted.set(digest, next);
        if (delta < SPEED_RESUME_SPIKE_BYTES) added += delta;
      }
      if (added > 0) transferred += added;
      const last = samples[samples.length - 1];
      if (!last) {
        samples.push({ at, transferred });
        return lastSpeed;
      }
      if (at !== last.at || transferred !== last.transferred) {
        samples.push({ at, transferred });
      }
      const cutoff = at - SPEED_WINDOW_MS;
      while (samples.length > 1 && samples[1]!.at <= cutoff) {
        samples.shift();
      }
      const oldest = samples[0];
      if (oldest) {
        const elapsed = (at - oldest.at) / 1000;
        const delta = transferred - oldest.transferred;
        if (elapsed >= 0.4 && delta > 0) {
          lastSpeed = delta / elapsed;
          lastSpeedAt = at;
        }
      }
      if (lastSpeed && at - lastSpeedAt <= SPEED_HOLD_MS) return lastSpeed;
      lastSpeed = undefined;
      return undefined;
    },
  };
}

export function applyOllamaPullEvent(
  name: string,
  layers: Map<string, PullLayer>,
  event: OllamaPullEvent,
  speed?: { update(layers: ReadonlyMap<string, PullLayer>): number | undefined },
): LocalModelPullProgress {
  const digest = event.digest?.trim();
  if (digest && (event.total || event.completed)) {
    const previous = layers.get(digest) ?? { completed: 0, total: 0 };
    layers.set(digest, {
      completed: event.completed ?? previous.completed,
      total: event.total ?? previous.total,
    });
  }

  let completed = 0;
  let total = 0;
  for (const layer of layers.values()) {
    completed += layer.completed;
    total += layer.total;
  }
  if (total === 0 && (event.total || event.completed)) {
    completed = event.completed ?? 0;
    total = event.total ?? 0;
  }

  const phase = event.error ? 'error' : classifyOllamaPullStatus(event.status || 'starting');
  const bytesPerSecond = speed ? speed.update(layers) : undefined;
  return {
    name,
    status: event.status || phase,
    phase,
    ...(total > 0
      ? { completed, total, percent: Math.min(100, Math.round((completed / total) * 100)) }
      : completed > 0
        ? { completed }
        : {}),
    ...(bytesPerSecond && bytesPerSecond > 0 ? { bytesPerSecond } : {}),
    done: false,
    ...(event.error ? { error: event.error } : {}),
  };
}

export function createThrottledEmitter(
  emit: (progress: LocalModelPullProgress) => void,
  intervalMs = 120,
): {
  push: (progress: LocalModelPullProgress, force?: boolean) => void;
  flush: () => void;
} {
  let lastSentAt = 0;
  let pending: LocalModelPullProgress | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const send = (progress: LocalModelPullProgress) => {
    lastSentAt = Date.now();
    pending = null;
    emit(progress);
  };

  return {
    push(progress, force = false) {
      const now = Date.now();
      if (force || progress.done || progress.error || now - lastSentAt >= intervalMs) {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        send(progress);
        return;
      }
      pending = progress;
      if (!timer) {
        timer = setTimeout(() => {
          timer = null;
          if (pending) send(pending);
        }, intervalMs);
      }
    },
    flush() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (pending) send(pending);
    },
  };
}
