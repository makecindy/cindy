import { describe, expect, it } from 'vitest';
import { classifySnapshotBatchFailure } from '@/device-link/rehydrate';

function fulfilled(value: unknown = undefined): PromiseFulfilledResult<unknown> {
  return { status: 'fulfilled', value };
}

function rejected(code: string): PromiseRejectedResult {
  return {
    status: 'rejected',
    reason: Object.assign(new Error(code), { code }),
  };
}

describe('classifySnapshotBatchFailure', () => {
  it('downgrades mixed availability errors when a sibling proves target reachability', () => {
    expect(classifySnapshotBatchFailure([
      fulfilled([]),
      rejected('DEVICE_OFFLINE'),
      rejected('REMOTE_DISABLED'),
      rejected('DEVICE_OFFLINE'),
    ])).toEqual({ kind: 'partial-transient' });
  });

  it('preserves an all-offline batch as an authoritative verdict', () => {
    const offline = rejected('DEVICE_OFFLINE');
    expect(classifySnapshotBatchFailure([
      offline,
      rejected('DEVICE_OFFLINE'),
      rejected('DEVICE_OFFLINE'),
      rejected('DEVICE_OFFLINE'),
    ])).toEqual({ kind: 'reject', error: offline.reason });
  });

  it('downgrades availability and other transient siblings after a target response', () => {
    expect(classifySnapshotBatchFailure([
      fulfilled([]),
      rejected('DEVICE_OFFLINE'),
      rejected('INVOKE_TIMEOUT'),
      rejected('REMOTE_DISABLED'),
    ])).toEqual({ kind: 'partial-transient' });
  });

  it('surfaces an all-disabled batch as authoritative unavailable', () => {
    const disabled = rejected('REMOTE_DISABLED');
    expect(classifySnapshotBatchFailure([
      disabled,
      rejected('REMOTE_DISABLED'),
      rejected('REMOTE_DISABLED'),
      rejected('REMOTE_DISABLED'),
    ])).toEqual({ kind: 'reject', error: disabled.reason });
  });

  it('preserves offline evidence over an unrelated transient when no sibling answered', () => {
    const offline = rejected('DEVICE_OFFLINE');
    expect(classifySnapshotBatchFailure([
      offline,
      rejected('DEVICE_OFFLINE'),
      rejected('INVOKE_TIMEOUT'),
      rejected('DEVICE_OFFLINE'),
    ])).toEqual({ kind: 'reject', error: offline.reason });
  });

  it('prefers remote-disabled when no sibling answered and availability markers conflict', () => {
    const disabled = rejected('REMOTE_DISABLED');
    expect(classifySnapshotBatchFailure([
      rejected('DEVICE_OFFLINE'),
      disabled,
      rejected('DEVICE_OFFLINE'),
      rejected('INVOKE_TIMEOUT'),
    ])).toEqual({ kind: 'reject', error: disabled.reason });
  });

  it('ignores permanent-only failures', () => {
    expect(classifySnapshotBatchFailure([
      rejected('CHANNEL_NOT_ALLOWED'),
      rejected('ACCESS_REVOKED'),
    ])).toEqual({ kind: 'none' });
  });
});
