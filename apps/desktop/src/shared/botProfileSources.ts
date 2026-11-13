import { createIpcError } from './ipc-errors.js';

export interface BotProfileSourceFailure {
  field: 'identitySource' | 'userContextSource';
  maxLength: number;
}

/** A deterministic rejection of the source text, not an arbitrary INVALID_PARAMS. */
export class BotProfileSourceTooLong extends Error {
  readonly code = 'INVALID_PARAMS';
  readonly failure: BotProfileSourceFailure;

  constructor(field: BotProfileSourceFailure['field'], maxLength: number) {
    super(createIpcError('INVALID_PARAMS', `${field} 超过长度上限 ${maxLength}`).message);
    this.failure = { field, maxLength };
  }
}

/** Shared by the real profile writer and cloud take-over preflight. No truncation. */
export function readBotProfileSource(value: unknown, field: BotProfileSourceFailure['field']): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw createIpcError('INVALID_PARAMS', `${field} 必须是字符串`);
  const text = value.trim();
  if (text.length > 12000) throw new BotProfileSourceTooLong(field, 12000);
  return text;
}

export function validateCompanionProfileSources(profile: { soul: string; user: string }): void {
  readBotProfileSource(profile.soul, 'identitySource');
  readBotProfileSource(profile.user, 'userContextSource');
}
