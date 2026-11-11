import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface TestSession {
  mode: 'signed-out' | 'local' | 'cloud';
  dataOwnerId: string | null;
  generation: number;
}

const mocks = vi.hoisted(() => ({
  root: '',
  ownerScopeKey: 'owner-1',
  boundaryPending: false,
  session: {
    mode: 'signed-out',
    dataOwnerId: null,
    generation: 0,
  } as TestSession,
}));

vi.mock('electron', () => ({
  app: {
    getPath: (kind: string) => (kind === 'temp' ? path.join(mocks.root, 'temp') : mocks.root),
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`encrypted:${value}`, 'utf-8'),
    decryptString: (value: Buffer) => {
      const raw = value.toString('utf-8');
      if (raw === 'corrupt') throw new Error('cannot decrypt');
      return raw.replace(/^encrypted:/, '');
    },
  },
}));

vi.mock('../../appSessionState.js', () => ({
  getActiveAppSession: () => ({ ...mocks.session }),
  activeOwnerScopeKey: () => mocks.ownerScopeKey,
  isAppSessionBoundaryPending: () => mocks.boundaryPending,
  dataOwnerStorageKey: (ownerId: string) => `key-${ownerId}`,
  ownerScopedUserDataPath: (...parts: string[]) => {
    const owner = mocks.session.dataOwnerId;
    return owner
      ? path.join(mocks.root, 'owners', `key-${owner}`, ...parts)
      : path.join(mocks.root, 'temp', ...parts);
  },
}));

vi.mock('../../logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn() }),
}));

vi.mock('../../ownerNamespaceMigration.js', () => ({
  hasLegacyOwnerNamespaceClaim: () => true,
}));

import { __testing, assertOwnerScopeSettledForWrite, claimLegacyImPath, ownerScopedImSecrets } from '../ownerScopedStorage';

function setSession(mode: TestSession['mode'], ownerId: string | null): void {
  mocks.session = { mode, dataOwnerId: ownerId, generation: mocks.session.generation + 1 };
}

function writeLegacySecret(name: string, value: string): string {
  const file = path.join(mocks.root, 'safe-storage', `${name}.enc`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(`encrypted:${value}`).toString('base64'), 'utf-8');
  return file;
}

describe('IM owner-scoped storage', () => {
  beforeEach(() => {
    mocks.root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-im-owner-scope-'));
    mocks.ownerScopeKey = 'owner-1';
    mocks.boundaryPending = false;
    setSession('signed-out', null);
  });

  afterEach(() => {
    fs.rmSync(mocks.root, { recursive: true, force: true });
  });

  it('assertOwnerScopeSettledForWrite fail-closes owner switches and in-flight boundaries', () => {
    // 写设置前的账号边界校验(PR #5155 review P1): scope 未变且无 boundary 在途才
    // 允许写 owner 域存储 —— 登出/切号过渡期间写入会落进登出命名空间或下一个
    // 账号; 不满足即抛错让保存失败重试。
    expect(() => assertOwnerScopeSettledForWrite(mocks.ownerScopeKey)).not.toThrow();

    mocks.boundaryPending = true;
    expect(() => assertOwnerScopeSettledForWrite(mocks.ownerScopeKey)).toThrow(/retry the save/);

    mocks.boundaryPending = false;
    mocks.ownerScopeKey = 'owner-2';
    expect(() => assertOwnerScopeSettledForWrite('owner-1')).toThrow(/retry the save/);
  });

  it('isolates credentials by data owner and never lets local claim cloud legacy data', () => {
    const legacy = writeLegacySecret('feishu_bot_app_secret', 'legacy-cloud-secret');

    setSession('local', 'local-v1');
    expect(ownerScopedImSecrets.read('feishu_bot_app_secret')).toBeNull();
    expect(fs.existsSync(legacy)).toBe(true);
    expect(ownerScopedImSecrets.write('feishu_bot_app_secret', 'local-secret')).toBe(true);

    setSession('cloud', 'cloud-a');
    expect(ownerScopedImSecrets.read('feishu_bot_app_secret')).toBe('legacy-cloud-secret');
    expect(fs.existsSync(legacy)).toBe(false);

    setSession('local', 'local-v1');
    expect(ownerScopedImSecrets.read('feishu_bot_app_secret')).toBe('local-secret');
  });

  it('allows only the first verified cloud owner to claim remaining legacy data', () => {
    setSession('cloud', 'cloud-a');
    const firstLegacy = writeLegacySecret('feishu_bot_app_id', 'legacy-app-id');
    expect(ownerScopedImSecrets.read('feishu_bot_app_id')).toBe('legacy-app-id');
    expect(fs.existsSync(firstLegacy)).toBe(false);

    setSession('cloud', 'cloud-b');
    const secondLegacy = writeLegacySecret('discord-bot-token', 'legacy-discord-token');
    expect(ownerScopedImSecrets.read('discord-bot-token')).toBeNull();
    expect(fs.existsSync(secondLegacy)).toBe(true);
    expect(JSON.parse(fs.readFileSync(__testing.legacyOwnerMarkerPath(), 'utf-8'))).toEqual({
      ownerKey: 'key-cloud-a',
    });
  });

  it('readResult distinguishes missing secrets from I/O or decryption failures', () => {
    setSession('local', 'local-v1');
    expect(ownerScopedImSecrets.readResult?.('telegram-bot-offline')).toEqual({
      kind: 'missing',
    });

    expect(ownerScopedImSecrets.write('telegram-bot-offline', '1')).toBe(true);
    expect(ownerScopedImSecrets.readResult?.('telegram-bot-offline')).toEqual({
      kind: 'value',
      value: '1',
    });

    const target = __testing.scopedSecretPath('telegram-bot-offline');
    expect(target).not.toBeNull();
    fs.writeFileSync(target!, Buffer.from('corrupt').toString('base64'), 'utf-8');
    expect(ownerScopedImSecrets.readResult?.('telegram-bot-offline')).toEqual({ kind: 'error' });
    // 旧 read 契约保持兼容：调用方若不需要区分，错误仍折叠为 null。
    expect(ownerScopedImSecrets.read('telegram-bot-offline')).toBeNull();
  });

  it('claims legacy working directories only for a verified cloud owner', () => {
    const legacy = path.join(mocks.root, 'im-working-dir', 'bot-a');
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, 'artifact.txt'), 'legacy', 'utf-8');

    setSession('local', 'local-v1');
    const localTarget = path.join(mocks.root, 'owners', 'key-local-v1', 'im-working-dir', 'bot-a');
    expect(claimLegacyImPath(legacy, localTarget)).toBe(false);
    expect(fs.existsSync(legacy)).toBe(true);

    setSession('cloud', 'cloud-a');
    const cloudTarget = path.join(mocks.root, 'owners', 'key-cloud-a', 'im-working-dir', 'bot-a');
    expect(claimLegacyImPath(legacy, cloudTarget)).toBe(true);
    expect(fs.readFileSync(path.join(cloudTarget, 'artifact.txt'), 'utf-8')).toBe('legacy');
    expect(fs.existsSync(legacy)).toBe(false);
  });
});
