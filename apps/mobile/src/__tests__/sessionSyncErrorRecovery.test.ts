import { describe, expect, it } from 'vitest';
import { shouldClearOperationErrorAfterSync } from '@/session/sessionSyncErrorRecovery';

describe('operation error cleanup after successful authoritative sync', () => {
  it.each(['INVOKE_TIMEOUT', 'NOT_CONNECTED', 'DEVICE_UNRESPONSIVE'])(
    'clears the %s occurrence that initiated recovery', (code) => {
      const error = { message: `[${code}] failed` };
      expect(shouldClearOperationErrorAfterSync(error, error)).toBe(true);
    },
  );

  it('preserves a newer timeout even when the text is identical', () => {
    const startedWith = { message: '[INVOKE_TIMEOUT] failed' };
    expect(shouldClearOperationErrorAfterSync({ ...startedWith }, startedWith)).toBe(false);
  });

  it('preserves an error raised during an initially healthy sync', () => {
    expect(shouldClearOperationErrorAfterSync({ message: '[INVOKE_TIMEOUT] failed' }, null)).toBe(false);
  });

  it('preserves deterministic operation failures', () => {
    const error = { message: '[NOT_FOUND] message not found' };
    expect(shouldClearOperationErrorAfterSync(error, error)).toBe(false);
  });

  it('does nothing when another operation already cleared the error', () => {
    expect(shouldClearOperationErrorAfterSync(null, { message: '[INVOKE_TIMEOUT] failed' })).toBe(false);
  });
});
