/**
 * 自动使用重置的本地存储：只记显式拨过的开关、恢复默认删除记录、按 Cindy 账号隔离，
 * 周窗口记录只存工作区 id 的哈希且过期即清。用 mkdtemp 的真实目录覆盖落盘与回读。
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
const weeklyPath = (who: string) =>
  path.join(userDataDir, 'codex-reset-credit-auto-use', who, 'weekly-resets.json');

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

describe('codex weekly reset records', () => {
  it('keeps a record per workspace without the raw workspace id', async () => {
    const store = await importStore();
    store.writeCodexWeeklyReset('openai', 'workspace-secret-1', { untilMs: 2_000, atMs: 1_000 });
    expect(store.readCodexWeeklyReset('openai', 'workspace-secret-1')).toEqual({
      untilMs: 2_000,
      atMs: 1_000,
    });
    expect(store.readCodexWeeklyReset('openai', 'workspace-2')).toBeNull();
    expect(fs.readFileSync(weeklyPath('owner-a'), 'utf8')).not.toContain('workspace-secret-1');
  });

  it('drops records of weeks that ended when writing a new one', async () => {
    const store = await importStore();
    store.writeCodexWeeklyReset('openai', 'w1', { untilMs: 2_000, atMs: 1_000 });
    store.writeCodexWeeklyReset('chatgpt-work', 'w2', { untilMs: 9_000, atMs: 3_000 });
    expect(store.readCodexWeeklyReset('openai', 'w1')).toBeNull();
    expect(store.readCodexWeeklyReset('chatgpt-work', 'w2')).toEqual({ untilMs: 9_000, atMs: 3_000 });
  });

  it('treats a damaged file as no record', async () => {
    const store = await importStore();
    fs.mkdirSync(path.dirname(weeklyPath('owner-a')), { recursive: true });
    fs.writeFileSync(weeklyPath('owner-a'), '{not json');
    expect(store.readCodexWeeklyReset('openai', 'w1')).toBeNull();
  });
});
