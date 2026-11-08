/**
 * Id of the V1 daily todo check routine. Teammates no longer keep todos: the V2 upgrade does not
 * carry this routine over and the runner skips one that is left behind.
 */
import { createHash } from 'node:crypto';
import { TODO_CHECK_ROUTINE_PREFIX } from '../../shared/botAutonomy.js';

/** 与例行任务引擎的 creationId 校验一致。 */
const ROUTINE_ID_PATTERN = /^[a-zA-Z0-9_-]{16,128}$/;

export function todoCheckRoutineId(botId: string): string {
  const plain = `${TODO_CHECK_ROUTINE_PREFIX}${botId}`;
  if (ROUTINE_ID_PATTERN.test(plain)) return plain;
  return `${TODO_CHECK_ROUTINE_PREFIX}${createHash('sha256').update(botId).digest('hex').slice(0, 40)}`;
}
