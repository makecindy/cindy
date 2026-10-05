/**
 * 自动使用重置的本地存储：只记显式拨过的开关、恢复默认删除记录、按 Cindy 账号隔离，
 * 并记下每个连接最近一次自动使用。用 mkdtemp 的真实目录覆盖落盘与回读。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let userDataDir = '';
let owner: string | null = 'owner-a';

vi.mock('electron', () => ({
  app: { getPath: () => userDataDir },
}));
vi.mock('../../maker-host/logger-adapter.js', () => ({
  desktopMakerLogger: { child: () => ({ info: () => {}, warn: () => {}, error: () => {} }) },
}));
vi.mock('../../maker-host/codex-account-auth.js', () => ({
  codexAccountOwnerDir: () => owner,
}));
vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => `scope:${owner ?? 'none'}`,
}));

async function importStore() {
  vi.resetModules();
  return import('../codexResetCreditAutoUseStore.js');
}

const settingsPath = (who: string) =>
  path.join(userDataDir, 'codex-reset-credit-auto-use', who, 'settings.json');
const lastUsePath = (who: string) =>
  path.join(userDataDir, 'codex-reset-credit-auto-use', who, 'last-auto-use.json');

beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-codex-reset-'));
  owner = 'owner-a';
});

afterEach(() => {
  fs.rmSync(userDataDir, { recursive: true, force: true });
});

describe('codex reset auto-use settings', () => {
  it('is off by default and writes nothing until the user turns it on', async () => {
    const store = await importStore();
    expect(store.readCodexResetCreditAutoUseState('openai')).toEqual({
      providerId: 'openai',
      enabled: false,
      isCustomized: false,
      defaultEnabled: false,
      lastAutoUse: null,
    });
    expect(store.listCodexResetCreditAutoUseProviderIds()).toEqual([]);
    expect(fs.existsSync(settingsPath('owner-a'))).toBe(false);
  });

  it('keeps one explicit choice per account and restores the default by deleting it', async () => {
    const store = await importStore();
    await store.writeCodexResetCreditAutoUse('openai', true);
    await store.writeCodexResetCreditAutoUse('chatgpt-work', false);
    expect(store.isCodexResetCreditAutoUseEnabled('openai')).toBe(true);
    expect(store.readCodexResetCreditAutoUseState('chatgpt-work')).toMatchObject({
      enabled: false,
      isCustomized: true,
    });
    expect(store.listCodexResetCreditAutoUseProviderIds()).toEqual(['openai']);
    expect(JSON.parse(fs.readFileSync(settingsPath('owner-a'), 'utf8'))).toEqual({
      providers: { openai: true, 'chatgpt-work': false },
    });

    await store.resetCodexResetCreditAutoUse('openai');
    await store.resetCodexResetCreditAutoUse('chatgpt-work');
    expect(store.readCodexResetCreditAutoUseState('openai').isCustomized).toBe(false);
    expect(fs.existsSync(settingsPath('owner-a'))).toBe(false);
  });

  it('keeps each Cindy account separate and is off without one', async () => {
    const store = await importStore();
    await store.writeCodexResetCreditAutoUse('openai', true);
    owner = 'owner-b';
    expect(store.isCodexResetCreditAutoUseEnabled('openai')).toBe(false);
    owner = null;
    expect(store.isCodexResetCreditAutoUseEnabled('openai')).toBe(false);
    await expect(store.writeCodexResetCreditAutoUse('openai', true)).rejects.toThrow();
    owner = 'owner-a';
    expect(store.isCodexResetCreditAutoUseEnabled('openai')).toBe(true);
  });

  it('rejects provider ids that cannot name an account', async () => {
    const store = await importStore();
    expect(() => store.readCodexResetCreditAutoUseState('../x')).toThrow();
    expect(store.isCodexResetCreditAutoUseEnabled('../x')).toBe(false);
  });
});

describe('codex reset last auto-use', () => {
  it('keeps the latest automatic use per connection and per Cindy account', async () => {
    const store = await importStore();
    store.recordCodexResetCreditAutoUse('openai', { atMs: 1_000, kind: 'usage-limit' });
    store.recordCodexResetCreditAutoUse('openai', { atMs: 2_000, kind: 'expiring' });
    store.recordCodexResetCreditAutoUse('chatgpt-work', { atMs: 3_000, kind: 'usage-limit' });
    expect(store.readCodexResetCreditAutoUseState('openai').lastAutoUse).toEqual({
      atMs: 2_000,
      kind: 'expiring',
    });
    expect(store.readCodexResetCreditAutoUseState('chatgpt-work').lastAutoUse).toEqual({
      atMs: 3_000,
      kind: 'usage-limit',
    });
    owner = 'owner-b';
    expect(store.readCodexResetCreditAutoUseState('openai').lastAutoUse).toBeNull();
  });

  it('ignores a damaged file and records nothing without a Cindy account', async () => {
    const store = await importStore();
    fs.mkdirSync(path.dirname(lastUsePath('owner-a')), { recursive: true });
    fs.writeFileSync(lastUsePath('owner-a'), '{not json');
    expect(store.readCodexResetCreditAutoUseState('openai').lastAutoUse).toBeNull();
    owner = null;
    store.recordCodexResetCreditAutoUse('openai', { atMs: 1_000, kind: 'expiring' });
    expect(fs.existsSync(lastUsePath('none'))).toBe(false);
  });
});
