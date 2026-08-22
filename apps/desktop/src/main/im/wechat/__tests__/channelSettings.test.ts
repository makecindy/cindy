import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ensureWechatManagedWorkingDir,
  readWechatChannelSettings,
  resetWechatWorkingDir,
  resolveWechatWorkingDirForNewConversation,
  writeWechatWorkingDir,
} from '../channelSettings';

let root = '';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-wechat-channel-settings-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('personal WeChat channel settings', () => {
  it('persists only a directory selected from an absolute existing path', async () => {
    const selected = path.join(root, 'project');
    const replacement = path.join(root, 'replacement');
    fs.mkdirSync(selected);
    fs.mkdirSync(replacement);

    await writeWechatWorkingDir(selected, root);
    const state = await writeWechatWorkingDir(replacement, root);

    expect(state.workingDir).toBe(fs.realpathSync.native(replacement).replace(/\\/g, '/'));
    expect(state.workingDirAvailable).toBe(true);
    expect(await readWechatChannelSettings(root)).toEqual(state);
  });

  it('falls back to a managed directory when the selected directory disappears', async () => {
    const selected = path.join(root, 'project');
    fs.mkdirSync(selected);
    await writeWechatWorkingDir(selected, root);
    fs.rmSync(selected, { recursive: true });

    expect((await readWechatChannelSettings(root)).workingDirAvailable).toBe(false);
    const resolved = await resolveWechatWorkingDirForNewConversation('bot-1', root);
    expect(resolved).toBe(path.join(root, 'im-working-dir', 'wechat-bot-1'));
    expect(fs.statSync(resolved).isDirectory()).toBe(true);
  });

  it('maps unsafe external bot ids to stable managed directory names', () => {
    const managedRoot = path.join(root, 'im-working-dir');
    const unsafeIds = ['../../escape', 'nested/bot', 'nested\\bot', 'bot:name'];

    for (const botId of unsafeIds) {
      const first = ensureWechatManagedWorkingDir(botId, root);
      const second = ensureWechatManagedWorkingDir(botId, root);
      expect(first).toBe(second);
      expect(path.dirname(first)).toBe(managedRoot);
      expect(path.basename(first)).toMatch(/^wechat-external-[a-f0-9]{24}$/);
      expect(fs.statSync(first).isDirectory()).toBe(true);
    }

    expect(ensureWechatManagedWorkingDir('bot-1', root)).toBe(
      path.join(managedRoot, 'wechat-bot-1'),
    );
    expect(fs.existsSync(path.join(root, 'escape'))).toBe(false);
  });

  it('reset removes the override and restores the managed directory', async () => {
    const selected = path.join(root, 'project');
    fs.mkdirSync(selected);
    await writeWechatWorkingDir(selected, root);

    expect(await resetWechatWorkingDir(root)).toEqual({
      version: 1,
      workingDir: null,
      workingDirAvailable: true,
    });
    expect(await resolveWechatWorkingDirForNewConversation('bot-2', root)).toBe(
      path.join(root, 'im-working-dir', 'wechat-bot-2'),
    );
  });

  it('rejects relative paths and files', async () => {
    await expect(writeWechatWorkingDir('relative', root)).rejects.toThrow(
      'WECHAT_WORKING_DIR_INVALID',
    );
    const file = path.join(root, 'file.txt');
    fs.writeFileSync(file, 'x');
    await expect(writeWechatWorkingDir(file, root)).rejects.toThrow(
      'WECHAT_WORKING_DIR_NOT_DIRECTORY',
    );
  });
});
