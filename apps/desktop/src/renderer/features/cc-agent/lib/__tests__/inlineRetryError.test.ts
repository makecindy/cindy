import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@/lib/makerChatStore';
import { hasInlineOverloadRetry } from '../inlineRetryError';

const capacity = 'Selected model is at capacity.';
const pending: ChatMessage = {
  clientId: '__auto_resume_pending__',
  role: 'assistant',
  content: '',
  systemCardType: 'auto-resume-pending',
  systemCardData: { error: capacity, attempt: 1, maxAttempts: 5 },
};
const input = {
  error: `${capacity} (auto-retry 3/4)`,
  errorReason: 'upstream-overload',
  isRecoverable: true,
  messages: [pending],
  continuationTurnClientId: null as string | null,
};

describe('duplicate inline overload retry', () => {
  it('hides duplicate progress even when host and provider budgets differ', () => {
    expect(hasInlineOverloadRetry(input)).toBe(true);
  });

  it('keeps overload feedback when there is no matching inline row', () => {
    expect(hasInlineOverloadRetry({ ...input, messages: [] })).toBe(false);
    expect(hasInlineOverloadRetry({
      ...input, messages: [{ ...pending, systemCardData: { error: 'other failure' } }],
    })).toBe(false);
  });

  it.each([
    'Reconnecting... 1/5 (401 Missing bearer)',
    'Reconnecting... 1/5 (rate limit)',
    'exceeded retry limit (rate-limit-retry 1/2)',
    'Reconnecting... 1/5',
  ])('preserves actionable or otherwise unmatched recovery: %s', (error) => {
    expect(hasInlineOverloadRetry({ ...input, error, errorReason: null })).toBe(false);
  });

  it('keeps terminal failures, including those carrying a stale retry suffix', () => {
    expect(hasInlineOverloadRetry({ ...input, isRecoverable: false })).toBe(false);
    expect(hasInlineOverloadRetry({ ...input, error: capacity })).toBe(false);
  });

  it('only uses an unfinished persisted row owned by the current continuation', () => {
    const row: ChatMessage = { ...pending, role: 'user', systemCardType: 'auto-resume' };
    expect(hasInlineOverloadRetry({ ...input, messages: [row] })).toBe(false);
    const owned = { ...input, messages: [row], continuationTurnClientId: row.clientId };
    expect(hasInlineOverloadRetry(owned)).toBe(true);
    expect(hasInlineOverloadRetry({
      ...owned, messages: [{ ...row, systemCardData: { ...row.systemCardData, outcome: 'failed' } }],
    })).toBe(false);
  });
});
