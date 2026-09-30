import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ directory: '', failWrite: false }));
vi.mock('electron', () => ({ app: { getPath: () => h.directory } }));
vi.mock('../../appSessionState.js', () => ({
  getActiveAppSession: () => ({ dataOwnerId: 'test-owner', generation: 1 }),
  isAppSessionBoundaryPending: () => false,
}));
vi.mock('../../utils/atomicWriteFile.js', async (original) => {
  const actual = await original<typeof import('../../utils/atomicWriteFile.js')>();
  return { ...actual, atomicWriteFileSync: (...args: Parameters<typeof actual.atomicWriteFileSync>) => {
    if (h.failWrite) throw new Error('test disk full');
    return actual.atomicWriteFileSync(...args);
  } };
});
import {
  bindNativeProviderAuth,
  isNativeProviderAuthBound,
  isNativeProviderCredentialRejected,
  unbindNativeProviderAuth,
} from '../nativeProviderAuthBinding.js';

beforeEach(() => {
  h.directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-revocation-'));
  h.failWrite = false;
});
afterEach(() => {
  fs.rmSync(h.directory, { recursive: true, force: true });
});
it('keeps a rejected credential suppressed in memory when the revocation write fails', () => {
  bindNativeProviderAuth('anthropic', { sharedSystem: true });
  expect(isNativeProviderAuthBound('anthropic')).toBe(true);
  const digest = 'a'.repeat(64);
  h.failWrite = true;
  expect(() => unbindNativeProviderAuth('anthropic', { revoked: true, rejectedCredentialDigest: digest })).toThrow();
  expect(isNativeProviderCredentialRejected('anthropic', digest)).toBe(true);
  expect(isNativeProviderCredentialRejected('anthropic', 'b'.repeat(64))).toBe(false);
});
it('an explicit revocation stops Cindy from using the native login until it is reconnected', () => {
  bindNativeProviderAuth('anthropic', { sharedSystem: true });
  unbindNativeProviderAuth('anthropic', { revoked: true });
  expect(isNativeProviderAuthBound('anthropic')).toBe(false);
  bindNativeProviderAuth('anthropic', { sharedSystem: true });
  expect(isNativeProviderAuthBound('anthropic')).toBe(true);
});
