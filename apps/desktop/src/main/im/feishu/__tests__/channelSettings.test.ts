import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  feishuChannelSettingsErrorCode,
  readFeishuChannelSettings,
  resetFeishuWorkingDir,
  resolveFeishuWorkingDir,
  writeFeishuWorkingDir,
} from '../channelSettings';

let root = '';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-feishu-channel-settings-'));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('Feishu channel settings', () => {
  it('reduces filesystem failures to a non-path error code', () => {
    const error = Object.assign(new Error(`ENOENT: ${path.join(root, 'private-project')}`), {
      code: 'ENOENT',
    });

    expect(feishuChannelSettingsErrorCode(error)).toBe('ENOENT');
    expect(feishuChannelSettingsErrorCode(error)).not.toContain(root);
    expect(feishuChannelSettingsErrorCode(new Error('private path'))).toBe('UNKNOWN');
  });

  it('persists a selected directory and can reset it', () => {
    const selected = path.join(root, 'project');
    fs.mkdirSync(selected);

    expect(writeFeishuWorkingDir(selected, root)).toMatchObject({
      workingDir: fs.realpathSync.native(selected).replace(/\\/g, '/'),
      workingDirAvailable: true,
    });
    expect(resetFeishuWorkingDir(root).workingDir).toBeNull();
  });

  it('keeps an unavailable selection visible while falling back safely', () => {
    const selected = path.join(root, 'project');
    fs.mkdirSync(selected);
    writeFeishuWorkingDir(selected, root);
    fs.rmSync(selected, { recursive: true });
    const fallback = path.join(root, 'managed');

    expect(readFeishuChannelSettings(root).workingDirAvailable).toBe(false);
    expect(resolveFeishuWorkingDir(() => fallback, root)).toBe(fallback);
  });

  it('rejects relative paths and files', () => {
    expect(() => writeFeishuWorkingDir('relative', root)).toThrow('FEISHU_WORKING_DIR_INVALID');
    const file = path.join(root, 'file.txt');
    fs.writeFileSync(file, 'x');
    expect(() => writeFeishuWorkingDir(file, root)).toThrow('FEISHU_WORKING_DIR_NOT_DIRECTORY');
  });
});
