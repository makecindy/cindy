import { describe, expect, it } from 'vitest';

import {
  inspectBotBundleEntries,
  normalizeBotBundleEntryPath,
} from '../botPortabilityArchive';

describe('bot portability archive safety', () => {
  it('accepts one normal top-level directory', () => {
    expect(
      inspectBotBundleEntries([
        { path: 'release-bot/', type: 'Directory', size: 0 },
        { path: 'release-bot/bot.json', type: 'File', size: 120 },
        { path: 'release-bot/SOUL.md', type: 'File', size: 30 },
      ]),
    ).toBe('release-bot');
  });

  it.each(['../escape', '/absolute/file', 'C:\\Users\\me\\file', 'root/../escape']) (
    'rejects unsafe path %s',
    (entryPath) => {
      expect(() => normalizeBotBundleEntryPath(entryPath)).toThrow();
    },
  );

  it('rejects multiple roots', () => {
    expect(() =>
      inspectBotBundleEntries([
        { path: 'one/bot.json', type: 'File', size: 10 },
        { path: 'two/SOUL.md', type: 'File', size: 10 },
      ]),
    ).toThrow('一个顶层目录');
  });

  it.each(['SymbolicLink', 'Link', 'CharacterDevice', 'BlockDevice', 'FIFO']) (
    'rejects %s entries',
    (type) => {
      expect(() =>
        inspectBotBundleEntries([{ path: 'bot/file', type, size: 0 }]),
      ).toThrow('不支持的文件类型');
    },
  );
});
