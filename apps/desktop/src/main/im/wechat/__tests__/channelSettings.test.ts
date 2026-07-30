import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  readWechatChannelSettings,
  resetWechatWorkingDir,
  resolveWechatWorkingDir,
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
  it('persists only a directory selected from an absolute existing path', () => {
    const selected = path.join(root, 'project');
    const replacement = path.join(root, 'replacement');
    fs.mkdirSync(selected);
    fs.mkdirSync(replacement);

    writeWechatWorkingDir(selected, root);
    const state = writeWechatWorkingDir(replacement, root);

    expect(state.workingDir).toBe(fs.realpathSync.native(replacement).replace(/\\/g, '/'));
    expect(state.workingDirAvailable).toBe(true);
    expect(readWechatChannelSettings(root)).toEqual(state);
  });

  it('falls back to a managed directory when the selected directory disappears', () => {
    const selected = path.join(root, 'project');
    fs.mkdirSync(selected);
    writeWechatWorkingDir(selected, root);
    fs.rmSync(selected, { recursive: true });

    expect(readWechatChannelSettings(root).workingDirAvailable).toBe(false);
    const resolved = resolveWechatWorkingDir('bot-1', root);
    expect(resolved).toBe(path.join(root, 'im-working-dir', 'wechat-bot-1'));
    expect(fs.statSync(resolved).isDirectory()).toBe(true);
  });

  it('maps unsafe external bot ids to stable managed directory names', () => {
    const managedRoot = path.join(root, 'im-working-dir');
    const unsafeIds = ['../../escape', 'nested/bot', 'nested\\bot', 'bot:name'];

    for (const botId of unsafeIds) {
      const first = resolveWechatWorkingDir(botId, root);
      const second = resolveWechatWorkingDir(botId, root);
      expect(first).toBe(second);
      expect(path.dirname(first)).toBe(managedRoot);
      expect(path.basename(first)).toMatch(/^wechat-external-[a-f0-9]{24}$/);
      expect(fs.statSync(first).isDirectory()).toBe(true);
    }

    expect(resolveWechatWorkingDir('bot-1', root)).toBe(
      path.join(managedRoot, 'wechat-bot-1'),
    );
    expect(fs.existsSync(path.join(root, 'escape'))).toBe(false);
  });

  it('reset removes the override and restores the managed directory', () => {
    const selected = path.join(root, 'project');
    fs.mkdirSync(selected);
    writeWechatWorkingDir(selected, root);

    expect(resetWechatWorkingDir(root)).toEqual({
      version: 1,
      workingDir: null,
      workingDirAvailable: true,
    });
    expect(resolveWechatWorkingDir('bot-2', root)).toBe(
      path.join(root, 'im-working-dir', 'wechat-bot-2'),
    );
  });

  it('rejects relative paths and files', () => {
    expect(() => writeWechatWorkingDir('relative', root)).toThrow('WECHAT_WORKING_DIR_INVALID');
    const file = path.join(root, 'file.txt');
    fs.writeFileSync(file, 'x');
    expect(() => writeWechatWorkingDir(file, root)).toThrow('WECHAT_WORKING_DIR_NOT_DIRECTORY');
  });
});
