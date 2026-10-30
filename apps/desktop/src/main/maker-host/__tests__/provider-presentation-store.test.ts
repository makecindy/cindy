import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';
import { builtinApiKeyPresentationId } from '../../secrets/builtinApiKeyBridge.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-presentation-test-'));
let owner = 'first';
let generation = 0;
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/never-used-here' } }));
vi.mock('../logger-adapter.js', () => ({
  desktopMakerLogger: { child: () => ({ info: () => {}, warn: () => {}, error: () => {} }) },
}));
vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => `${owner}:${generation}`,
  ownerScopedUserDataPath: (name: string) => path.join(tmpDir, owner, name),
}));
const {
  readProviderPresentation,
  setProviderPresentation,
  readLocalCodexPresentation,
  renameLocalCodexProvider,
  setLocalCodexProviderRemoved,
  retainInvalidatedProviderPresentation,
  retainProviderPresentationAfterAuthChange,
} = await import('../provider-presentation-store.js');
const { withCrossProcessLock } = await import('../../device-link/crossProcessLock.js');
afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

it.each(['openai', 'anthropic', 'xai', 'google', 'generic-oauth'])('does not fail committed %s authentication when presentation cannot be written', async (id) => {
  owner = `failed-presentation-${id}`;
  const write = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => { throw new Error('test readonly disk'); });
  try {
    await expect(retainProviderPresentationAfterAuthChange(id)).resolves.toBeUndefined();
    expect(write).toHaveBeenCalled();
  } finally {
    write.mockRestore();
    owner = 'first';
  }
});

it.each(['gemini', 'openai-images'])('restores the visible row for removed builtin key slot %s', async (slot) => {
  owner = `builtin-${slot}`;
  const visibleId = builtinApiKeyPresentationId(slot);
  expect(visibleId).toBe(slot === 'openai-images' ? 'openai' : 'gemini');
  await setProviderPresentation(visibleId, { removed: true });
  await retainProviderPresentationAfterAuthChange(visibleId);
  expect(readProviderPresentation(visibleId).removed).toBe(false);
  if (slot === 'openai-images') expect(readProviderPresentation(slot)).toEqual({});
  owner = 'first';
});

it('persists generic OAuth restoration after a removed connection logs in again', async () => {
  owner = 'generic-restoration';
  await setProviderPresentation('generic-oauth', { name: 'Work', removed: true });
  await retainProviderPresentationAfterAuthChange('generic-oauth');
  expect(JSON.parse(fs.readFileSync(path.join(tmpDir, owner, 'local-codex-provider-prefs.json'), 'utf8')).providers['generic-oauth']).toEqual({ name: 'Work', removed: false });
  owner = 'first';
});

it('persists the name across removal and reconnect, isolated by Cindy owner', async () => {
  expect(readLocalCodexPresentation()).toEqual({});
  await renameLocalCodexProvider('  My OpenAI  ');
  await setLocalCodexProviderRemoved(true);
  expect(readLocalCodexPresentation()).toEqual({ name: 'My OpenAI', removed: true });
  owner = 'second';
  expect(readLocalCodexPresentation()).toEqual({});
  await renameLocalCodexProvider('Other OpenAI');
  owner = 'first';
  expect(readLocalCodexPresentation()).toEqual({ name: 'My OpenAI', removed: true });
  await setLocalCodexProviderRemoved(false);
  expect(readLocalCodexPresentation()).toEqual({ name: 'My OpenAI', removed: false });
  expect(
    JSON.parse(
      fs.readFileSync(path.join(tmpDir, owner, 'local-codex-provider-prefs.json'), 'utf8'),
    ),
  ).toEqual({ name: 'My OpenAI', removed: false });
});
it('rejects empty or oversized names without changing the saved name', async () => {
  await expect(renameLocalCodexProvider('  ')).rejects.toThrow();
  await expect(renameLocalCodexProvider('a'.repeat(129))).rejects.toThrow();
  expect(readLocalCodexPresentation()).toEqual({ name: 'My OpenAI', removed: false });
});

it('keeps each native connection and local service name separate', async () => {
  await setProviderPresentation('anthropic', { name: 'Work Claude', removed: false });
  await setProviderPresentation('xai', { name: 'Grok', removed: true });
  await setProviderPresentation('ollama', { name: 'My machine' });
  expect(readProviderPresentation('anthropic')).toEqual({ name: 'Work Claude', removed: false });
  expect(readProviderPresentation('xai')).toEqual({ name: 'Grok', removed: true });
  expect(readProviderPresentation('ollama')).toEqual({ name: 'My machine' });
  expect(readLocalCodexPresentation()).toEqual({ name: 'My OpenAI', removed: false });
});

it.each(['anthropic', 'xai'])('retains invalidated legacy %s without reviving deleted entries', async (id) => {
  owner = `legacy-${id}`;
  expect(readProviderPresentation(id)).toEqual({});
  await retainInvalidatedProviderPresentation(id);
  expect(readProviderPresentation(id)).toEqual({ removed: false });
  await setProviderPresentation(id, { name: 'My account', removed: true });
  await retainInvalidatedProviderPresentation(id);
  expect(readProviderPresentation(id)).toEqual({ name: 'My account', removed: true });
  owner = `other-${id}`;
  expect(readProviderPresentation(id)).toEqual({});
});

it('merges queued edits with the latest disk snapshot instead of the cached providers', async () => {
  owner = 'concurrent-edit';
  await setProviderPresentation('anthropic', { name: 'Original' });
  const file = path.join(tmpDir, owner, 'local-codex-provider-prefs.json');
  let pending!: Promise<void>;
  await withCrossProcessLock(`${file}.lock`, { label: 'test-presentation-writer' }, async (status) => {
    expect(status.held).toBe(true);
    pending = setProviderPresentation('anthropic', { removed: true });
    fs.writeFileSync(file, JSON.stringify({ name: 'Native', providers: {
      anthropic: { name: 'Renamed elsewhere' }, xai: { name: 'Other provider' },
    } }));
  });
  await pending;
  expect(readProviderPresentation('anthropic')).toEqual({ name: 'Renamed elsewhere', removed: true });
  expect(readProviderPresentation('xai')).toEqual({ name: 'Other provider' });
  expect(readProviderPresentation('openai')).toEqual({ name: 'Native' });
});

it('does not revive a provider deleted while background retention waits for the lock', async () => {
  owner = 'concurrent-delete';
  const file = path.join(tmpDir, owner, 'local-codex-provider-prefs.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let pending!: Promise<void>;
  await withCrossProcessLock(`${file}.lock`, { label: 'test-presentation-delete' }, async (status) => {
    expect(status.held).toBe(true);
    pending = retainInvalidatedProviderPresentation('anthropic');
    fs.writeFileSync(file, JSON.stringify({ providers: { anthropic: { removed: true } } }));
  });
  await pending;
  expect(readProviderPresentation('anthropic')).toEqual({ removed: true });
});

it('rejects an old owner generation even if the owner returns before lock acquisition', async () => {
  owner = 'owner-aba';
  const pending = setProviderPresentation('openai', { name: 'Stale edit' });
  generation += 2;
  await expect(pending).rejects.toThrow('scope changed');
  expect(readProviderPresentation('openai')).toEqual({});
});
