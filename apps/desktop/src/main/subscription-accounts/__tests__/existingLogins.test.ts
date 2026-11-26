// Unit: the settings discovery / attach entry must bind the reviewed directory and identity.
// Existing pool tests start with a known account id. They cannot catch a removed profile being
// offered, a changed login between review and connect, or a selection reused by another owner.
import path from 'node:path';
import { beforeEach, expect, it, vi } from 'vitest';
import type { SubscriptionPoolConfig } from '../../../shared/subscriptionAccounts.js';

const h = vi.hoisted(() => ({
  home: process.cwd(), owner: 'owner-a', identity: 'person@example.test', workspace: 'personal',
  pool: null as SubscriptionPoolConfig | null, attach: vi.fn(), read: vi.fn(),
}));
vi.mock('node:os', () => ({ homedir: () => h.home, hostname: () => 'fixture' }));
vi.mock('node:fs/promises', () => ({
  realpath: async (dir: string) => dir, stat: async () => ({ isDirectory: () => true }),
  opendir: async () => (async function* () {
    for (const name of ['.claude-work', '.claude-person', '.claude-cindy-other', '.codex-person'])
      yield { name, isDirectory: () => true };
  })(),
}));
vi.mock('../../appSessionState.js', () => ({
  getActiveAppSession: () => ({ dataOwnerId: h.owner }), activeOwnerScopeKey: () => h.owner,
  isAppSessionBoundaryPending: () => false,
}));
vi.mock('../../userDataPath.js', () => ({ getUserDataDir: () => path.join(h.home, 'fixture-data') }));
vi.mock('../store.js', () => ({ readPool: () => h.pool, loginDirectoryKey: (directory: string) => directory, loginIdentityKey: () => 'identity-key' }));
vi.mock('../runtime.js', () => ({
  attachExternalLogin: h.attach, alreadyUsesLogin: () => false, offerSystemLogin: () => false,
}));
vi.mock('../nativeCli.js', () => ({
  readExistingLogin: async (provider: string, directory: string) => {
    const auth = await h.read();
    return { login: { directory, identity: auth.identity, accountKey: provider === 'openai' ? h.workspace : undefined } };
  },
}));
import { existingLoginSession } from '../existingLogins.js';

beforeEach(() => {
  h.owner = 'owner-a';
  h.workspace = 'personal';
  h.identity = 'person@example.test';
  h.read.mockReset().mockImplementation(async () => ({ authenticated: true, identity: h.identity }));
  h.attach.mockReset();
  h.pool = null;
});

it('offers the verified external profile, skips removed and managed homes, and consumes the owner’s selection once', async () => {
  h.pool = { accounts: [], strategy: 'least', dismissedLogins: [path.join(h.home, '.claude-work')] };
  const session = existingLoginSession('anthropic');
  const candidates = await session.discover();
  expect(candidates.map(row => row.directory)).toEqual([path.join(h.home, '.claude-person')]);
  expect(h.read).toHaveBeenCalledTimes(1);
  const receipt = candidates[0]!.receipt;
  h.owner = 'owner-b';
  await expect(existingLoginSession('anthropic').attach(receipt)).rejects.toThrow();
  expect(h.attach).not.toHaveBeenCalled();
  h.owner = 'owner-a';
  await session.attach(receipt);
  expect(h.attach).toHaveBeenCalledWith('anthropic', { directory: candidates[0]!.directory, identity: h.identity }, expect.any(Function));
  await expect(session.attach(receipt)).rejects.toThrow();
});

it.each(['anthropic', 'openai'] as const)('refuses a replaced %s identity or workspace before attaching', async provider => {
  const session = existingLoginSession(provider);
  const [candidate] = await session.pick(path.join(h.home, 'custom'));
  if (provider === 'openai') h.workspace = 'work';
  else h.identity = 'other@example.test';
  await expect(session.attach(candidate!.receipt)).rejects.toThrow('Account changed');
  expect(h.attach).not.toHaveBeenCalled();
});
