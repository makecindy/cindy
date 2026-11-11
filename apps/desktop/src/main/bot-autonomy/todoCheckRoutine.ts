/**
 * Id of the V1 daily todo check routine. Teammates no longer keep todos: the V2 upgrade removes this
 * routine without carrying it over.
 */
import { createHash } from 'node:crypto';
import { TODO_CHECK_ROUTINE_PREFIX } from '../../shared/botAutonomy.js';

/** Same rule as the V1 routine engine's creationId check. */
const ROUTINE_ID_PATTERN = /^[a-zA-Z0-9_-]{16,128}$/;

export function todoCheckRoutineId(botId: string): string {
  const plain = `${TODO_CHECK_ROUTINE_PREFIX}${botId}`;
  if (ROUTINE_ID_PATTERN.test(plain)) return plain;
  return `${TODO_CHECK_ROUTINE_PREFIX}${createHash('sha256').update(botId).digest('hex').slice(0, 40)}`;
}
