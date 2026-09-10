import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-presentation-test-'));
let owner = 'first';
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/never-used-here' } }));
vi.mock('../logger-adapter.js', () => ({
  desktopMakerLogger: { child: () => ({ info: () => {}, warn: () => {}, error: () => {} }) },
}));
vi.mock('../../appSessionState.js', () => ({
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
afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

it.each(['openai', 'anthropic', 'xai', 'google', 'generic-oauth'])('does not fail committed %s authentication when presentation cannot be written', (id) => {
  owner = `failed-presentation-${id}`;
  const write = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => { throw new Error('test readonly disk'); });
  try {
    expect(() => retainProviderPresentationAfterAuthChange(id)).not.toThrow();
    expect(write).toHaveBeenCalled();
  } finally {
    write.mockRestore();
    owner = 'first';
  }
});

it('persists generic OAuth restoration after a removed connection logs in again', () => {
  owner = 'generic-restoration';
  setProviderPresentation('generic-oauth', { name: 'Work', removed: true });
  retainProviderPresentationAfterAuthChange('generic-oauth');
  expect(JSON.parse(fs.readFileSync(path.join(tmpDir, owner, 'local-codex-provider-prefs.json'), 'utf8')).providers['generic-oauth']).toEqual({ name: 'Work', removed: false });
  owner = 'first';
});

it('persists the name across removal and reconnect, isolated by Cindy owner', () => {
  expect(readLocalCodexPresentation()).toEqual({});
  renameLocalCodexProvider('  My OpenAI  ');
  setLocalCodexProviderRemoved(true);
  expect(readLocalCodexPresentation()).toEqual({ name: 'My OpenAI', removed: true });
  owner = 'second';
  expect(readLocalCodexPresentation()).toEqual({});
  renameLocalCodexProvider('Other OpenAI');
  owner = 'first';
  expect(readLocalCodexPresentation()).toEqual({ name: 'My OpenAI', removed: true });
  setLocalCodexProviderRemoved(false);
  expect(readLocalCodexPresentation()).toEqual({ name: 'My OpenAI', removed: false });
  expect(
    JSON.parse(
      fs.readFileSync(path.join(tmpDir, owner, 'local-codex-provider-prefs.json'), 'utf8'),
    ),
  ).toEqual({ name: 'My OpenAI', removed: false });
});
it('rejects empty or oversized names without changing the saved name', () => {
  expect(() => renameLocalCodexProvider('  ')).toThrow();
  expect(() => renameLocalCodexProvider('a'.repeat(129))).toThrow();
  expect(readLocalCodexPresentation()).toEqual({ name: 'My OpenAI', removed: false });
});

it('keeps each native connection and local service name separate', () => {
  setProviderPresentation('anthropic', { name: 'Work Claude', removed: false });
  setProviderPresentation('xai', { name: 'Grok', removed: true });
  setProviderPresentation('ollama', { name: 'My machine' });
  expect(readProviderPresentation('anthropic')).toEqual({ name: 'Work Claude', removed: false });
  expect(readProviderPresentation('xai')).toEqual({ name: 'Grok', removed: true });
  expect(readProviderPresentation('ollama')).toEqual({ name: 'My machine' });
  expect(readLocalCodexPresentation()).toEqual({ name: 'My OpenAI', removed: false });
});

it.each(['anthropic', 'xai'])('retains invalidated legacy %s without reviving deleted entries', (id) => {
  owner = `legacy-${id}`;
  expect(readProviderPresentation(id)).toEqual({});
  retainInvalidatedProviderPresentation(id);
  expect(readProviderPresentation(id)).toEqual({ removed: false });
  setProviderPresentation(id, { name: 'My account', removed: true });
  retainInvalidatedProviderPresentation(id);
  expect(readProviderPresentation(id)).toEqual({ name: 'My account', removed: true });
  owner = `other-${id}`;
  expect(readProviderPresentation(id)).toEqual({});
});
