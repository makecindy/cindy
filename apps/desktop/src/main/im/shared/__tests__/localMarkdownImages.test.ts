import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { materializeLocalMarkdownImages } from '../localMarkdownImages';

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-im-local-image-'));
  tempRoots.push(root);
  return root;
}

function makeDeps(mediaAbsPath: string) {
  return {
    realpath: (value: string) => fs.realpath(value),
    stat: (value: string) => fs.stat(value),
    readFile: (value: string) => fs.readFile(value),
    ingest: vi.fn(async () => ({ url: 'cindy-media://blobs/test.png' })),
    resolveMediaUrl: vi.fn(() => ({ absPath: mediaAbsPath })),
  };
}

afterEach(async () => {
  for (const root of tempRoots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true });
  }
});

describe('materializeLocalMarkdownImages', () => {
  it('物化 workingDir 内的真实图片、去重，并移除本机路径', async () => {
    const workingDir = await makeTempRoot();
    const sourcePath = path.join(workingDir, 'generated.png');
    const mediaAbsPath = path.join(workingDir, 'media-store.png');
    await fs.writeFile(sourcePath, PNG_BYTES);
    const deps = makeDeps(mediaAbsPath);

    const result = await materializeLocalMarkdownImages(
      {
        text: `完成\n![测试图片](${sourcePath})\n![重复](${sourcePath})`,
        workingDir,
        sessionId: 'session-1',
      },
      deps,
    );

    expect(result).toEqual({
      absPaths: [mediaAbsPath],
      text: '完成\n测试图片\n重复',
    });
    expect(deps.ingest).toHaveBeenCalledTimes(1);
    expect(deps.ingest).toHaveBeenCalledWith({
      buffer: PNG_BYTES,
      mimeType: 'image/png',
      sessionId: 'session-1',
    });
  });

  it('拒绝 workingDir 外路径和伪装成图片的非图片字节', async () => {
    const parent = await makeTempRoot();
    const workingDir = path.join(parent, 'work');
    const siblingDir = path.join(parent, 'work-secret');
    await fs.mkdir(workingDir);
    await fs.mkdir(siblingDir);
    const outsidePath = path.join(siblingDir, 'outside.png');
    const fakeImagePath = path.join(workingDir, 'fake.png');
    await fs.writeFile(outsidePath, PNG_BYTES);
    await fs.writeFile(fakeImagePath, 'not an image');
    const deps = makeDeps(path.join(parent, 'unused.png'));
    const text = `![outside](${outsidePath})\n![fake](${fakeImagePath})`;

    await expect(
      materializeLocalMarkdownImages({ text, workingDir, sessionId: 'session-2' }, deps),
    ).resolves.toEqual({ absPaths: [], text });
    expect(deps.ingest).not.toHaveBeenCalled();
  });

  it('只物化限制数量内的图片，未处理项保留原 Markdown', async () => {
    const workingDir = await makeTempRoot();
    const first = path.join(workingDir, 'first.png');
    const second = path.join(workingDir, 'second.png');
    await fs.writeFile(first, PNG_BYTES);
    await fs.writeFile(second, PNG_BYTES);
    const deps = makeDeps(path.join(workingDir, 'stored.png'));

    const result = await materializeLocalMarkdownImages(
      {
        text: `![first](${first})\n![second](${second})`,
        workingDir,
        sessionId: 'session-3',
        maxImages: 1,
      },
      deps,
    );

    expect(result.absPaths).toHaveLength(1);
    expect(result.text).toBe(`first\n![second](${second})`);
    expect(deps.ingest).toHaveBeenCalledTimes(1);
  });

  it('解析最终正文中的 cindy-media 图片，不重复入仓并移除内部协议地址', async () => {
    const workingDir = await makeTempRoot();
    const mediaAbsPath = path.join(workingDir, 'stored.png');
    await fs.writeFile(mediaAbsPath, PNG_BYTES);
    const deps = makeDeps(mediaAbsPath);
    const url = `cindy-media://blobs/${'a'.repeat(64)}.png`;

    const result = await materializeLocalMarkdownImages(
      {
        text: `已收到\n![发还给你的图片](${url})`,
        workingDir,
        sessionId: 'session-4',
      },
      deps,
    );

    expect(result).toEqual({
      absPaths: [await fs.realpath(mediaAbsPath)],
      text: '已收到\n发还给你的图片',
    });
    expect(deps.resolveMediaUrl).toHaveBeenCalledWith(url);
    expect(deps.ingest).not.toHaveBeenCalled();
  });

  it('已由 tool_result 收集的同一受管图片只清理正文，不重复追加', async () => {
    const workingDir = await makeTempRoot();
    const mediaAbsPath = path.join(workingDir, 'stored.png');
    await fs.writeFile(mediaAbsPath, PNG_BYTES);
    const deps = makeDeps(mediaAbsPath);
    const url = `cindy-media://blobs/${'b'.repeat(64)}.png`;

    const result = await materializeLocalMarkdownImages(
      {
        text: `![图片](${url})`,
        workingDir,
        sessionId: 'session-5',
        existingAbsPaths: [mediaAbsPath],
      },
      deps,
    );

    expect(result).toEqual({ absPaths: [], text: '图片' });
    expect(deps.ingest).not.toHaveBeenCalled();
  });
});
