import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ensureWecomManagedWorkingDir,
  readWecomChannelSettings,
  resetWecomWorkingDir,
  resolveWecomWorkingDirForNewConversation,
  writeWecomWorkingDir,
} from '../channelSettings';

/** owner 隔离用例的可变 owner 桩 — 经 vi.mock 注入 ownerScopedImUserDataPath。 */
const ownerState = vi.hoisted(() => ({ key: 'owner-a' }));
let ownersRoot = '';

vi.mock('../../ownerScopedStorage', () => ({
  ownerScopedImUserDataPath: (...parts: string[]) =>
    path.join(ownersRoot, ownerState.key, ...parts),
}));

let root = '';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-wecom-channel-settings-'));
  ownersRoot = path.join(root, 'owners');
  ownerState.key = 'owner-a';
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** 存储契约: normalizeWorkingDirForStorage 统一成正斜杠(逻辑路径, 非宿主表示)。 */
function storageForm(dir: string): string {
  return fs.realpathSync.native(dir).replace(/\\/g, '/');
}

describe('WeCom channel settings', () => {
  it('persists only a directory selected from an absolute existing path', async () => {
    const selected = path.join(root, 'project');
    const replacement = path.join(root, 'replacement');
    fs.mkdirSync(selected);
    fs.mkdirSync(replacement);

    await writeWecomWorkingDir(selected, root);
    const state = await writeWecomWorkingDir(replacement, root);

    expect(state.workingDir).toBe(storageForm(replacement));
    expect(state.workingDirAvailable).toBe(true);
    expect(await readWecomChannelSettings(root)).toEqual(state);
    // 原子写入不留 tmp 残留; 可用性探测不留探针残留。
    expect(fs.readdirSync(root).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    expect(fs.readdirSync(replacement)).toEqual([]);
  });

  it('falls back to a managed directory when the selected directory disappears', async () => {
    const selected = path.join(root, 'project');
    fs.mkdirSync(selected);
    await writeWecomWorkingDir(selected, root);
    const savedStorageForm = storageForm(selected);
    fs.rmSync(selected, { recursive: true });

    expect((await readWecomChannelSettings(root)).workingDirAvailable).toBe(false);
    // override 保留(不静默清掉用户的显式选择), 新对话回退托管目录。
    expect((await readWecomChannelSettings(root)).workingDir).toBe(savedStorageForm);
    const resolved = await resolveWecomWorkingDirForNewConversation('bot-1', root);
    expect(resolved).toBe(
      path.join(root, 'im-working-dir', `wecom-${Buffer.from('bot-1').toString('base64url')}`),
    );
    expect(fs.statSync(resolved).isDirectory()).toBe(true);
  });

  it('resolves the configured directory again once it becomes available', async () => {
    const selected = path.join(root, 'project');
    fs.mkdirSync(selected);
    await writeWecomWorkingDir(selected, root);
    expect(await resolveWecomWorkingDirForNewConversation('bot-1', root)).toBe(
      storageForm(selected),
    );
  });

  it('never touches user-created files with a probe-like name in the configured directory', async () => {
    const selected = path.join(root, 'project');
    fs.mkdirSync(selected);
    await writeWecomWorkingDir(selected, root);
    fs.writeFileSync(path.join(selected, '.cindy-workdir-probe-user-note'), 'user data');

    expect((await readWecomChannelSettings(root)).workingDirAvailable).toBe(true);
    // 只清理 Cindy 自己的 UUID 探针; 用户同前缀文件必须原样保留(P0)。
    expect(fs.readFileSync(path.join(selected, '.cindy-workdir-probe-user-note'), 'utf8')).toBe(
      'user data',
    );
    expect(fs.readdirSync(selected)).toEqual(['.cindy-workdir-probe-user-note']);
  });

  it('maps arbitrary bot ids to stable managed directory names', () => {
    const managedRoot = path.join(root, 'im-working-dir');
    const ids = ['../../escape', 'nested/bot', 'nested\\bot', 'bot:name', '空间名'];

    for (const botId of ids) {
      const first = ensureWecomManagedWorkingDir(botId, root);
      const second = ensureWecomManagedWorkingDir(botId, root);
      expect(first).toBe(second);
      expect(path.dirname(first)).toBe(managedRoot);
      expect(path.basename(first)).toMatch(/^wecom-[A-Za-z0-9_-]{1,96}$/);
      expect(fs.statSync(first).isDirectory()).toBe(true);
    }

    expect(fs.existsSync(path.join(root, 'escape'))).toBe(false);
  });

  it('reset removes the override and restores the managed directory', async () => {
    const selected = path.join(root, 'project');
    fs.mkdirSync(selected);
    await writeWecomWorkingDir(selected, root);

    expect(await resetWecomWorkingDir(root)).toEqual({
      version: 1,
      workingDir: null,
      workingDirAvailable: true,
    });
    expect(fs.existsSync(path.join(root, 'wecom-channel.json'))).toBe(false);
    expect(await resolveWecomWorkingDirForNewConversation('bot-2', root)).toBe(
      path.join(root, 'im-working-dir', `wecom-${Buffer.from('bot-2').toString('base64url')}`),
    );
  });

  it('rejects relative paths and files', async () => {
    await expect(writeWecomWorkingDir('relative', root)).rejects.toThrow(
      'WECOM_WORKING_DIR_INVALID',
    );
    const file = path.join(root, 'file.txt');
    fs.writeFileSync(file, 'x');
    await expect(writeWecomWorkingDir(file, root)).rejects.toThrow(
      'WECOM_WORKING_DIR_NOT_DIRECTORY',
    );
  });

  it('treats corrupted settings JSON as no override', async () => {
    fs.writeFileSync(path.join(root, 'wecom-channel.json'), '{not json', 'utf8');

    expect(await readWecomChannelSettings(root)).toEqual({
      version: 1,
      workingDir: null,
      workingDirAvailable: true,
    });
    expect(await resolveWecomWorkingDirForNewConversation('bot-1', root)).toBe(
      path.join(root, 'im-working-dir', `wecom-${Buffer.from('bot-1').toString('base64url')}`),
    );
  });

  it('ignores a non-absolute workingDir left in the settings file', async () => {
    fs.writeFileSync(
      path.join(root, 'wecom-channel.json'),
      JSON.stringify({ version: 1, workingDir: 'relative/path' }),
      'utf8',
    );

    const state = await readWecomChannelSettings(root);
    expect(state.workingDir).toBeNull();
    expect(state.workingDirAvailable).toBe(true);
  });

  it('marks a configured path that became a file as unavailable and falls back', async () => {
    const file = path.join(root, 'now-a-file');
    fs.writeFileSync(file, 'x');
    fs.writeFileSync(
      path.join(root, 'wecom-channel.json'),
      JSON.stringify({ version: 1, workingDir: file }),
      'utf8',
    );

    const state = await readWecomChannelSettings(root);
    expect(state.workingDir).toBeTruthy();
    expect(state.workingDirAvailable).toBe(false);
    expect(await resolveWecomWorkingDirForNewConversation('bot-1', root)).toBe(
      path.join(root, 'im-working-dir', `wecom-${Buffer.from('bot-1').toString('base64url')}`),
    );
  });

  it('treats a read-only directory as unavailable (POSIX permission semantics)', async () => {
    // Windows 的 chmod 不对目录构成写保护(§3.2 平台能力差异), 真实权限语义
    // 只在 POSIX 实跑; stat 层行为已由上面用例覆盖。
    if (process.platform === 'win32') return;
    const selected = path.join(root, 'readonly');
    fs.mkdirSync(selected);
    try {
      fs.chmodSync(selected, 0o500);
      fs.writeFileSync(
        path.join(root, 'wecom-channel.json'),
        JSON.stringify({ version: 1, workingDir: selected }),
        'utf8',
      );

      const state = await readWecomChannelSettings(root);
      expect(state.workingDir).toBeTruthy();
      expect(state.workingDirAvailable).toBe(false);
      expect(await resolveWecomWorkingDirForNewConversation('bot-1', root)).toBe(
        path.join(root, 'im-working-dir', `wecom-${Buffer.from('bot-1').toString('base64url')}`),
      );
    } finally {
      fs.chmodSync(selected, 0o700);
    }
  });

  it('scopes the settings file and managed dirs to the active data owner', async () => {
    const selected = path.join(root, 'project');
    fs.mkdirSync(selected);

    expect((await writeWecomWorkingDir(selected)).workingDir).toBe(storageForm(selected));
    expect(fs.existsSync(path.join(ownersRoot, 'owner-a', 'wecom-channel.json'))).toBe(true);

    // 换 owner 后读到的是自己的(尚不存在的)配置, 不跨账号泄漏;托管目录也各自开。
    ownerState.key = 'owner-b';
    expect(await readWecomChannelSettings()).toEqual({
      version: 1,
      workingDir: null,
      workingDirAvailable: true,
    });
    const managedB = ensureWecomManagedWorkingDir('bot-1');
    expect(managedB).toBe(
      path.join(
        ownersRoot,
        'owner-b',
        'im-working-dir',
        `wecom-${Buffer.from('bot-1').toString('base64url')}`,
      ),
    );
    expect(fs.existsSync(path.join(ownersRoot, 'owner-b', 'wecom-channel.json'))).toBe(false);
  });
});
