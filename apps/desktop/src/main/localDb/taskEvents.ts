import type { DataOwnerPushStamp } from '../../shared/dataOwnerPush.js';
import type { Message } from '../../renderer/lib/ccAgent.types.js';
import { createLogger } from '../logger.js';

export type TaskChangeEvent =
  | { kind: 'message'; sessionId: string; message: Message }
  | { kind: 'state'; sessionId: string; state: Record<string, unknown> };

let listener: ((event: TaskChangeEvent, owner: DataOwnerPushStamp) => void) | undefined;
const log = createLogger('task-events');

/** Observe committed Host changes without introducing another persistence or replay path. */
export function setTaskChangeListener(next: typeof listener): void { listener = next; }

export function publishTaskChange(event: TaskChangeEvent, owner: DataOwnerPushStamp | null | undefined): void {
  if (!listener || !owner) return;
  try { listener(event, owner); }
  catch { log.warn('task change listener failed'); }
}
