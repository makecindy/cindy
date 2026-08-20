import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { materializeMarkdownImages } from '../markdownImages';

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-markdown-image-'));
  tempRoots.push(root);
  return root;
}

function makeDeps(mediaAbsPath: string) {
  return {
    realpath: (value: string) => fs.realpath(value),
    stat: (value: string) => fs.stat(value),
    readFile: (value: string) => fs.readFile(value),
    ingest: vi.fn(async () => ({
      url: `cindy-media://blobs/${'a'.repeat(64)}.png`,
    })),
    resolveMediaUrl: vi.fn(() => ({ absPath: mediaAbsPath })),
  };
}

afterEach(async () => {
  for (const root of tempRoots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true });
  }
});

describe('materializeMarkdownImages', () => {
  it('将 workingDir 内本地图片改写为托管 URL，并提供去图片正文', async () => {
    const workingDir = await makeTempRoot();
    const sourcePath = path.join(workingDir, 'qr.png');
    const mediaAbsPath = path.join(workingDir, 'media', 'qr.png');
    await fs.writeFile(sourcePath, PNG_BYTES);
    const deps = makeDeps(mediaAbsPath);

    const result = await materializeMarkdownImages(
      {
        text: `扫码登录\n![登录二维码](${sourcePath})`,
        workingDir,
        sessionId: 'session-local',
      },
      deps,
    );

    expect(result).toEqual({
      absPaths: [mediaAbsPath],
      managedText: `扫码登录\n![登录二维码](cindy-media://blobs/${'a'.repeat(64)}.png)`,
      textWithoutImages: '扫码登录\n登录二维码',
    });
    expect(deps.ingest).toHaveBeenCalledWith({
      buffer: PNG_BYTES,
      mimeType: 'image/png',
      sessionId: 'session-local',
    });
  });

  it('远程上下文禁用本地路径时不触碰文件系统', async () => {
    const deps = {
      realpath: vi.fn(async (value: string) => value),
      stat: vi.fn(async () => ({ isFile: () => true, size: PNG_BYTES.length })),
      readFile: vi.fn(async () => PNG_BYTES),
      ingest: vi.fn(async () => ({
        url: `cindy-media://blobs/${'b'.repeat(64)}.png`,
      })),
      resolveMediaUrl: vi.fn(() => ({ absPath: '/unused.png' })),
    };
    const text = '![远端图片](/home/remote/output.png)';

    await expect(
      materializeMarkdownImages(
        {
          text,
          workingDir: '/home/remote',
          sessionId: 'session-remote',
          allowLocalPaths: false,
        },
        deps,
      ),
    ).resolves.toEqual({
      absPaths: [],
      managedText: text,
      textWithoutImages: text,
    });
    expect(deps.realpath).not.toHaveBeenCalled();
    expect(deps.readFile).not.toHaveBeenCalled();
    expect(deps.ingest).not.toHaveBeenCalled();
  });

  it('拒绝通过 workingDir 内符号链接读取目录外图片', async () => {
    const parent = await makeTempRoot();
    const workingDir = path.join(parent, 'work');
    const outsideDir = path.join(parent, 'outside');
    await fs.mkdir(workingDir);
    await fs.mkdir(outsideDir);
    const outsidePath = path.join(outsideDir, 'secret.png');
    const linkedPath = path.join(workingDir, 'linked.png');
    await fs.writeFile(outsidePath, PNG_BYTES);
    await fs.symlink(outsidePath, linkedPath);
    const deps = makeDeps(path.join(parent, 'unused.png'));
    const text = `![越界图片](${linkedPath})`;

    await expect(
      materializeMarkdownImages({ text, workingDir, sessionId: 'session-symlink' }, deps),
    ).resolves.toEqual({
      absPaths: [],
      managedText: text,
      textWithoutImages: text,
    });
    expect(deps.ingest).not.toHaveBeenCalled();
  });
});
