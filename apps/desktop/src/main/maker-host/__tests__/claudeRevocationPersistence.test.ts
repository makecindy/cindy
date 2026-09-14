import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ directory: '', blob: '', failWrite: false }));
vi.mock('electron', () => ({ app: { getPath: () => h.directory } }));
vi.mock('node:child_process', () => ({ execFileSync: vi.fn(() => h.blob) }));
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
import { bindNativeProviderAuth, unbindNativeProviderAuth, isNativeProviderCredentialRejected } from '../nativeProviderAuthBinding.js';
import { claudeOAuthCredentialDigest, readClaudeAiOAuth, readClaudeAiOAuthUnbound } from '../claude-credentials-store.js';

function credential(token: string) {
  h.blob = JSON.stringify({ claudeAiOauth: { accessToken: token } });
  fs.writeFileSync(path.join(h.directory, '.credentials.json'), h.blob);
}
beforeEach(() => {
  h.directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-revocation-'));
  h.failWrite = false;
  vi.stubEnv('CLAUDE_CONFIG_DIR', h.directory);
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(h.directory, { recursive: true, force: true });
});
it('stops bound reads after a failed revocation write without changing native credentials', () => {
  credential('test-rejected');
  bindNativeProviderAuth('anthropic', { sharedSystem: true });
  const digest = claudeOAuthCredentialDigest({ accessToken: 'test-rejected' });
  h.failWrite = true;
  expect(() => unbindNativeProviderAuth('anthropic', { revoked: true, rejectedCredentialDigest: digest })).toThrow();
  expect(isNativeProviderCredentialRejected('anthropic', digest)).toBe(true);
  expect(readClaudeAiOAuth()).toBeNull();
  expect(readClaudeAiOAuthUnbound()?.accessToken).toBe('test-rejected');
  expect(fs.readFileSync(path.join(h.directory, '.credentials.json'), 'utf8')).toBe(h.blob);
  credential('test-new-account');
  expect(readClaudeAiOAuth()?.accessToken).toBe('test-new-account');
});
