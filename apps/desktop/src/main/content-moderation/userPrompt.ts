import { randomUUID } from 'node:crypto';
import { ModerationClient } from './client.js';
import { USER_PROMPT_MAX_LENGTH } from '../../shared/userPrompt.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import {
  getModerationIdentity,
  isModerationIdentityCurrent,
} from './identity.js';

const TEXT_DEADLINE_MS = 5_000;

export type UserPromptModerationResult = 'allow' | 'reject' | 'cancelled';

export function validateUserPromptReviewValue(value: unknown): asserts value is string {
  if (typeof value !== 'string') {
    throwIpcError('INVALID_PARAMS', 'user prompt must be a string');
  }
  if (value.length > USER_PROMPT_MAX_LENGTH) {
    throwIpcError(
      'INVALID_PARAMS',
      `user prompt exceeds ${USER_PROMPT_MAX_LENGTH} characters`,
    );
  }
}

export async function moderateUserPrompt(
  text: string,
  client = new ModerationClient(),
): Promise<UserPromptModerationResult> {
  if (text.trim().length === 0) return 'allow';
  const identity = getModerationIdentity();
  if (!identity) return 'allow';

  const operationId = randomUUID();
  const decision = await client.review({
    signBaseUrl: identity.signBaseUrl,
    accessToken: identity.accessToken,
    membershipId: identity.membershipId,
    businessCode: 'maker-sys-prompt',
    dataId: `sys-prompt:${identity.membershipId}:${operationId}`,
    items: [{
      type: 'TEXT',
      data: text,
      content_id: `${operationId}:sys-prompt`,
    }],
    extra: { scene: 'settings' },
    deadlineMs: TEXT_DEADLINE_MS,
  });
  if (!isModerationIdentityCurrent(identity)) return 'cancelled';
  return decision;
}
