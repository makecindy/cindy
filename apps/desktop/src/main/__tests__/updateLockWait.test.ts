import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  isWindowsUpdateLockSharingViolation,
  shouldKeepWaitingForWindowsUpdateLock,
} from '../updateLockWait';

describe('Windows update lock wait', () => {
  it('keeps waiting after 30s when Retry still owns .updating', () => {
    expect(
      shouldKeepWaitingForWindowsUpdateLock({
        lockExists: true,
        elapsedMs: 30_000,
        maxWaitMs: 30_000,
        holderPid: 4242,
        holderAlive: true,
        unlinkFailed: true,
        sharingViolation: true,
      }),
    ).toBe(true);
  });

  it('attempts unlink after the timeout even if a live PID was recycled', () => {
    expect(
      shouldKeepWaitingForWindowsUpdateLock({
        lockExists: true,
        elapsedMs: 30_000,
        maxWaitMs: 30_000,
        holderPid: 4242,
        holderAlive: true,
        unlinkFailed: false,
        sharingViolation: false,
      }),
    ).toBe(false);
  });

  it('keeps waiting when unlink fails because the updater still holds the file', () => {
    expect(
      shouldKeepWaitingForWindowsUpdateLock({
        lockExists: true,
        elapsedMs: 45_000,
        maxWaitMs: 30_000,
        holderPid: 4242,
        holderAlive: true,
        unlinkFailed: true,
        sharingViolation: true,
      }),
    ).toBe(true);
  });

  it('stops waiting after the timeout when a sharing violation is not from a live updater PID', () => {
    expect(
      shouldKeepWaitingForWindowsUpdateLock({
        lockExists: true,
        elapsedMs: 45_000,
        maxWaitMs: 30_000,
        holderPid: 4242,
        holderAlive: false,
        unlinkFailed: true,
        sharingViolation: true,
      }),
    ).toBe(false);
  });

  it('treats EBUSY as the updater-owned sharing violation', () => {
    expect(isWindowsUpdateLockSharingViolation({ code: 'EBUSY', errno: -4082 })).toBe(true);
    expect(isWindowsUpdateLockSharingViolation({ code: 'EPERM', errno: -1 })).toBe(false);
  });

  it('stops waiting after the timeout when unlink fails for an unrelated ACL error', () => {
    expect(
      shouldKeepWaitingForWindowsUpdateLock({
        lockExists: true,
        elapsedMs: 45_000,
        maxWaitMs: 30_000,
        holderPid: null,
        holderAlive: false,
        unlinkFailed: true,
        sharingViolation: false,
      }),
    ).toBe(false);
  });

  it('is used by Windows startup instead of a fixed 30s break', () => {
    const source = fs.readFileSync(
      new URL('../bootstrap-electron.ts', import.meta.url),
      'utf8',
    );
    expect(source).toContain('shouldKeepWaitingForWindowsUpdateLock');
    expect(source).toContain('sharingViolation');
  });

  it('stops waiting once the lock is gone', () => {
    expect(
      shouldKeepWaitingForWindowsUpdateLock({
        lockExists: false,
        elapsedMs: 1_000,
        maxWaitMs: 30_000,
        holderPid: null,
        holderAlive: false,
        unlinkFailed: false,
        sharingViolation: false,
      }),
    ).toBe(false);
  });
});
