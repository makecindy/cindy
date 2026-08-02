import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  createChatAttachmentStageHandler,
  type ChatAttachmentStageDeps,
  type ChatAttachmentStageOpenedSource,
  type ChatAttachmentStageSourceStat,
} from '../chatAttachmentStage';

function fileStat(dev = 1n, ino = 1n, size = 64n): ChatAttachmentStageSourceStat {
  return { dev, ino, size, isFile: () => true };
}

function openedSource(
  overrides: Partial<ChatAttachmentStageOpenedSource> = {},
): ChatAttachmentStageOpenedSource {
  return {
    stat: vi.fn(async () => fileStat()),
    copyTo: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    ...overrides,
  };
}

function makeDeps(overrides: Partial<ChatAttachmentStageDeps> = {}): ChatAttachmentStageDeps {
  return {
    isPathAllowed: () => true,
    realpath: vi.fn(async (filePath) => filePath),
    stat: vi.fn(async () => fileStat()),
    openSource: vi.fn(async () => openedSource()),
    stageCopy: vi.fn(async ({ copyTo }) => {
      const target = path.resolve('cache', 'staged-setup.exe.bin');
      await copyTo(`${target}.part`);
      return target;
    }),
    ...overrides,
  };
}

describe('createChatAttachmentStageHandler', () => {
  it('copies a dangerous local file from the validated handle to an inert .bin path', async () => {
    const source = openedSource();
    const deps = makeDeps({ openSource: vi.fn(async () => source) });
    const sourcePath = path.resolve('downloads', 'setup.exe');

    await expect(
      createChatAttachmentStageHandler(deps)({ sourcePath, suggestedName: 'setup.exe' }),
    ).resolves.toEqual({ success: true, path: path.resolve('cache', 'staged-setup.exe.bin') });

    expect(deps.stat).toHaveBeenCalledWith(sourcePath);
    expect(deps.openSource).toHaveBeenCalledWith(sourcePath);
    expect(source.copyTo).toHaveBeenCalledWith(
      `${path.resolve('cache', 'staged-setup.exe.bin')}.part`,
    );
    expect(source.close).toHaveBeenCalledOnce();
  });

  it('stages a dangerous physical path even when the display name has no executable suffix', async () => {
    const source = openedSource();
    const deps = makeDeps({ openSource: vi.fn(async () => source) });
    const sourcePath = path.resolve('downloads', 'setup.exe');

    await expect(
      createChatAttachmentStageHandler(deps)({ sourcePath, suggestedName: 'attachment' }),
    ).resolves.toEqual({ success: true, path: path.resolve('cache', 'staged-setup.exe.bin') });
  });

  it('rejects safe extensions and forbidden or relative source paths before copying', async () => {
    const deps = makeDeps();
    await expect(
      createChatAttachmentStageHandler(deps)({
        sourcePath: path.resolve('downloads', 'archive.zip'),
        suggestedName: 'archive.zip',
      }),
    ).resolves.toEqual({ success: false, code: 'unsupported_type' });
    await expect(
      createChatAttachmentStageHandler(deps)({
        sourcePath: 'setup.exe',
        suggestedName: 'setup.exe',
      }),
    ).resolves.toEqual({ success: false, code: 'invalid_source' });

    const forbidden = makeDeps({ isPathAllowed: () => false });
    await expect(
      createChatAttachmentStageHandler(forbidden)({
        sourcePath: path.resolve('downloads', 'setup.exe'),
        suggestedName: 'setup.exe',
      }),
    ).resolves.toEqual({ success: false, code: 'forbidden' });
    expect(deps.stageCopy).not.toHaveBeenCalled();
    expect(forbidden.stageCopy).not.toHaveBeenCalled();
  });

  it('rejects a source object replaced after validation and closes the handle', async () => {
    const replacement = openedSource({ stat: vi.fn(async () => fileStat(1n, 2n)) });
    const deps = makeDeps({ openSource: vi.fn(async () => replacement) });

    await expect(
      createChatAttachmentStageHandler(deps)({
        sourcePath: path.resolve('downloads', 'setup.exe'),
        suggestedName: 'setup.exe',
      }),
    ).resolves.toEqual({ success: false, code: 'forbidden' });
    expect(deps.stageCopy).not.toHaveBeenCalled();
    expect(replacement.close).toHaveBeenCalledOnce();
  });

  it('fails closed when the cache writer returns an executable destination', async () => {
    const deps = makeDeps({
      stageCopy: vi.fn(async () => path.resolve('cache', 'setup.exe')),
    });
    await expect(
      createChatAttachmentStageHandler(deps)({
        sourcePath: path.resolve('downloads', 'setup.exe'),
        suggestedName: 'setup.exe',
      }),
    ).resolves.toEqual({ success: false, code: 'copy_failed' });
  });
});
