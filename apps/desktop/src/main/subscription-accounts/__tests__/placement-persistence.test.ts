import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// #10557 opt-in / unit with unique real temporary files: existing ipc tests fake the
// settings writer and cannot prove false overrides survive disk/cache reconstruction.
// Only owner/path/logger and unrelated pool metadata are injected; production placement,
// normalization, override writer, cross-process lock and atomic filesystem commit run unchanged.
const state = vi.hoisted(() => ({ dir: '', owner: 'owner-a' }));
vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => state.owner,
  ownerScopedUserDataPath: (file: string) => path.join(state.dir, state.owner, file),
}));
vi.mock('../../maker-host/logger-adapter.js', () => ({ desktopMakerLogger: { info() {}, warn() {} } }));
vi.mock('../store.js', () => ({
  accountIdValid: () => false, readLegacyCodexAccountId: () => undefined,
  readOpenAiLegacyAccountsIfReadable: () => [], readPool: () => null, updatePool: vi.fn(),
}));
import { readProviderAutoRejoinRecovered, writeProviderAutoRejoinRecovered } from '../placement.js';
const ref = { kind: 'openai' as const, providerId: 'openai' };
const file = () => path.join(state.dir, state.owner, 'subscription-account-placement.json');
beforeEach(() => {
  state.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-recovery-preference-'));
  state.owner = 'owner-a';
});
afterEach(() => { fs.rmSync(state.dir, { recursive: true, force: true }); });

it('defaults off without creating an override or directory', () => {
  expect(readProviderAutoRejoinRecovered(ref)).toBe(false);
  expect(fs.existsSync(file())).toBe(false);
});
it('persists explicit false and reloads owner/provider-isolated values from disk', async () => {
  const other = { ...ref, providerId: 'openai-sub-12345678' };
  await writeProviderAutoRejoinRecovered(ref, true);
  await writeProviderAutoRejoinRecovered(other, false);
  expect(JSON.parse(fs.readFileSync(file(), 'utf8')).autoRejoinRecovered).toEqual({ openai: true, [other.providerId]: false });
  state.owner = 'owner-b';
  expect(readProviderAutoRejoinRecovered(ref)).toBe(false);
  await writeProviderAutoRejoinRecovered(ref, false);
  state.owner = 'owner-a'; // Changing the resolved path invalidates the real in-memory cache.
  expect(readProviderAutoRejoinRecovered(ref)).toBe(true);
  expect(readProviderAutoRejoinRecovered(other)).toBe(false);
  await writeProviderAutoRejoinRecovered(ref, false);
  state.owner = 'owner-b'; readProviderAutoRejoinRecovered(ref);
  state.owner = 'owner-a';
  expect(readProviderAutoRejoinRecovered(ref)).toBe(false);
  expect(JSON.parse(fs.readFileSync(file(), 'utf8')).autoRejoinRecovered.openai).toBe(false);
});
it('observes an external atomic disable and rejects unsupported provider writes', async () => {
  await writeProviderAutoRejoinRecovered(ref, true);
  const next = file() + '.next';
  fs.writeFileSync(next, JSON.stringify({ autoRejoinRecovered: { openai: false } }));
  fs.renameSync(next, file());
  expect(readProviderAutoRejoinRecovered(ref)).toBe(false);
  await expect(writeProviderAutoRejoinRecovered({ kind: 'anthropic', providerId: 'anthropic' }, true)).rejects.toThrow();
  expect(JSON.parse(fs.readFileSync(file(), 'utf8')).autoRejoinRecovered).toEqual({ openai: false });
});
it('fails closed on corrupt persisted authorization and never overwrites it', async () => {
  await writeProviderAutoRejoinRecovered(ref, true);
  fs.writeFileSync(file(), '{broken');
  expect(readProviderAutoRejoinRecovered(ref)).toBe(false);
  await expect(writeProviderAutoRejoinRecovered(ref, true)).rejects.toThrow();
  expect(fs.readFileSync(file(), 'utf8')).toBe('{broken');
});
