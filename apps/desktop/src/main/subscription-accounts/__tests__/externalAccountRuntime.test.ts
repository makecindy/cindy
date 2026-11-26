/** Unit regression: accountDirectory and normalizePoolFile must retain a persisted
 * external-runtime requirement even if its runtime configuration disappears.
 * Existing account tests used unmarked stock accounts; the minimal failure is a
 * marked account with a missing/disabled config silently getting a bundled home.
 * This suite uses synthetic account metadata and a resolver fake, no CLI/network/credentials.
 */
import { beforeEach, expect, it, vi } from 'vitest';
import path from 'node:path';
const h = vi.hoisted(() => ({ raw: {} as Record<string, unknown>, directory: undefined as string | undefined,
  strictError: undefined as Error | undefined, strictReads: 0 }));
vi.mock('node:os', async original => ({ ...(await original<typeof import('node:os')>()), homedir: () => '/synthetic/home' }));
vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => 'test-owner',
  getActiveAppSession: () => ({ dataOwnerId: 'test-owner' }),
  ownerScopedUserDataPath: () => '/synthetic/subscription-accounts.json',
}));
vi.mock('../../maker-host/logger-adapter.js', () => ({ desktopMakerLogger: { info: vi.fn(), warn: vi.fn() } }));
vi.mock('../../maker-host/external-claude-runtime.js', () => ({
  externalClaudeDirectoryForAccount: () => { h.strictReads++; if (h.strictError) throw h.strictError; return h.directory; },
  peekExternalClaudeAccountId: () => h.directory ? 'default' : undefined,
}));
vi.mock('../../maker-host/override-settings-file.js', () => ({
  createOverrideSettingsFile: ({ normalize }: { normalize: (raw: unknown) => unknown }) => ({
    read: () => normalize(h.raw), readStrict: () => normalize(h.raw), invalidateIfChanged() {},
  }),
}));
import { accountDirectory, normalizePoolFile } from '../store.js';
const marked = () => ({ id: 'default', paused: false, limit: 1, weight: 1, externalRuntime: 'external-claude' });
beforeEach(() => {
  h.directory = undefined;
  h.strictError = undefined;
  h.strictReads = 0;
  h.raw = { pools: { anthropic: { strategy: 'least', accounts: [marked()] } }, bindings: {} };
});
it('keeps an unmarked stock account usable when an unrelated external configuration is broken', () => {
  h.raw = { pools: { anthropic: { accounts: [{ id: 'default' }] } } };
  h.strictError = new Error('unreadable external configuration');
  expect(accountDirectory('anthropic', 'default')).toBe(path.join('/synthetic/home', '.claude'));
  expect(h.strictReads).toBe(0);
});
it('retains the account requirement through normalization and rejects missing configuration', () => {
  expect(normalizePoolFile(h.raw).pools.anthropic?.accounts[0].externalRuntime).toBe('external-claude');
  expect(() => accountDirectory('anthropic', 'default')).toThrow('unavailable; launch is blocked');
});
it('uses the configured profile only when the account is explicitly marked', () => {
  h.directory = '/synthetic/terminal-profile';
  expect(accountDirectory('anthropic', 'default')).toBe(h.directory);
  h.raw = { pools: { anthropic: { accounts: [{ id: 'default' }] } } };
  expect(() => accountDirectory('anthropic', 'default')).toThrow('explicitly registered');
});
it.each(['unknown-runtime', null, false])('rejects a corrupt persisted requirement (%s) instead of dropping it', value => {
  h.raw = { pools: { anthropic: { accounts: [{ ...marked(), externalRuntime: value }] } } };
  expect(() => normalizePoolFile(h.raw)).toThrow('Unrecognized external Claude account requirement');
  expect(() => accountDirectory('anthropic', 'default')).toThrow('Unrecognized external Claude account requirement');
});
