import type { DataOwnerPushStamp } from '../../shared/dataOwnerPush.js';
import type { Message } from '../../renderer/lib/ccAgent.types.js';
import { createLogger } from '../logger.js';

export type TaskChangeEvent =
  | { kind: 'message'; sessionId: string; message: Message }
  | { kind: 'state'; sessionId: string; state: Record<string, unknown> };

type Listener = (event: TaskChangeEvent, owner: DataOwnerPushStamp) => void;
const listeners: Partial<Record<TaskChangeEvent['kind'], Listener>> = {};
const log = createLogger('task-events');

/** Observe committed Host changes without introducing another persistence or replay path. */
export function setTaskChangeListener(next: Listener | undefined,
  kinds: readonly TaskChangeEvent['kind'][] = ['message', 'state']): void {
  listeners.message = kinds.includes('message') ? next : undefined;
  listeners.state = kinds.includes('state') ? next : undefined;
}

/** Producers check before constructing an event or resolving its owner. */
export function hasTaskChangeListener(kind: TaskChangeEvent['kind']): boolean { return !!listeners[kind]; }

export function publishTaskChange(event: TaskChangeEvent, owner: DataOwnerPushStamp | null | undefined): void {
  const listener = listeners[event.kind];
  if (!listener || !owner) return;
  try { listener(event, owner); }
  catch { log.warn('task change listener failed'); }
}
