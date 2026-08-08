import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const remoteFileMocks = vi.hoisted(() => ({
  materializeSshRemoteFile: vi.fn(),
}));

vi.mock('../../../file-browser/ssh-media', () => remoteFileMocks);

import {
  materializeLocalMarkdownFiles,
  materializeLocalMarkdownImages,
  sanitizeLocalMarkdownImageRefs,
} from '../localMarkdownImages';

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
    readBoundedFile: (value: string, maxBytes: number, containWithin?: string) =>
      import('../../../utils/readBoundedFile').then(({ readBoundedFileFollowLinks }) =>
        readBoundedFileFollowLinks(
          value,
          maxBytes,
          containWithin === undefined ? undefined : { containWithin },
        ),
      ),
    ingest: vi.fn(async () => ({ url: 'cindy-media://blobs/test.png' })),
    resolveMediaUrl: vi.fn(() => ({ absPath: mediaAbsPath })),
  };
}

afterEach(async () => {
  for (const root of tempRoots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true });
  }
});

beforeEach(() => {
  vi.clearAllMocks();
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
        text: `完成\n![测试图片](${sourcePath})\n![重复](<${sourcePath}> "caption")`,
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

  it('parses an optional Markdown title after a plain local destination', async () => {
    const workingDir = await makeTempRoot();
    const sourcePath = path.join(workingDir, 'generated.png');
    const mediaAbsPath = path.join(workingDir, 'media-store.png');
    await fs.writeFile(sourcePath, PNG_BYTES);
    const deps = makeDeps(mediaAbsPath);

    await expect(
      materializeLocalMarkdownImages(
        {
          text: `![preview](${sourcePath} "caption")`,
          workingDir,
          sessionId: 'session-title',
        },
        deps,
      ),
    ).resolves.toEqual({ absPaths: [mediaAbsPath], text: 'preview' });
  });

  it('materializes SSH Markdown images through the remote file service', async () => {
    const cacheRoot = await makeTempRoot();
    const cachePath = path.join(cacheRoot, 'remote-image.png');
    const mediaAbsPath = path.join(cacheRoot, 'media-store.png');
    await fs.writeFile(cachePath, PNG_BYTES);
    remoteFileMocks.materializeSshRemoteFile.mockResolvedValue({
      ok: true,
      cachePath,
      size: PNG_BYTES.length,
      relPath: 'out.png',
    });
    const deps = makeDeps(mediaAbsPath);

    const result = await materializeLocalMarkdownImages(
      {
        text: '![remote](/srv/project/out.png)',
        workingDir: '/srv/project',
        remoteHostId: 'ssh-host-1',
        sessionId: 'session-ssh-image',
      },
      deps,
    );

    expect(remoteFileMocks.materializeSshRemoteFile).toHaveBeenCalledWith(
      { remoteHostId: 'ssh-host-1', workdir: '/srv/project' },
      '/srv/project/out.png',
      20 * 1024 * 1024,
    );
    expect(result).toEqual({ absPaths: [mediaAbsPath], text: 'remote' });
    expect(deps.ingest).toHaveBeenCalledWith({
      buffer: PNG_BYTES,
      mimeType: 'image/png',
      sessionId: 'session-ssh-image',
    });
  });

  it('does not reopen a validated local image path for reading', async () => {
    const parent = await makeTempRoot();
    const workingDir = path.join(parent, 'work');
    const sourceDir = path.join(workingDir, 'slot');
    const outsideDir = path.join(parent, 'outside');
    const sourcePath = path.join(sourceDir, 'generated.png');
    const outsidePath = path.join(outsideDir, 'generated.png');
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.mkdir(outsideDir);
    const sourceBytes = Buffer.concat([PNG_BYTES, Buffer.from([0x01])]);
    await fs.writeFile(sourcePath, sourceBytes);
    const outsideBytes = Buffer.from(sourceBytes);
    outsideBytes[outsideBytes.length - 1] ^= 0xff;
    await fs.writeFile(outsidePath, outsideBytes);
    const deps = makeDeps(path.join(parent, 'media-store.png'));
    deps.stat = async (value: string) => {
      const stat = await fs.stat(value);
      await fs.rename(sourceDir, `${sourceDir}-original`);
      await fs.symlink(outsideDir, sourceDir);
      return stat;
    };
    deps.readBoundedFile = vi.fn(async () => null);

    const result = await materializeLocalMarkdownImages(
      {
        text: `![preview](${sourcePath})`,
        workingDir,
        sessionId: 'session-race',
      },
      deps,
    );

    expect(result).toEqual({ absPaths: [], text: `![preview](${sourcePath})` });
    expect(deps.ingest).not.toHaveBeenCalled();
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

  it('existingAbsPaths 未经 realpath 规范化时仍然去重命中', async () => {
    // 上一个用例只在 os.tmpdir() 恰好是软链的宿主上才有区分力(macOS 的 /var →
    // /private/var);CI 是 ubuntu、/tmp 不是软链,去重键写错也照样绿。这里把
    // realpath 整个注入,不碰文件系统,三平台同一行为:入表键若不过 realpath,
    // 别名查不中规范路径,同一张受管图片会被重复追加。
    const canonical = path.join(path.sep, 'canonical', 'store', 'a.png');
    const alias = path.join(path.sep, 'alias', 'store', 'a.png');
    const realpath = vi.fn(async (value: string) => (value === alias ? canonical : value));
    const deps = {
      ...makeDeps(alias),
      realpath,
      // 去重命中时下面两个不会被调用;留桩是为了让回退的失败表现为「多追加一张」
      // 而不是抛错,断言才指向真正的原因。
      stat: async () => ({ isFile: () => true, size: PNG_BYTES.length }),
      readFile: async () => PNG_BYTES,
    };

    const result = await materializeLocalMarkdownImages(
      {
        text: `![图片](cindy-media://blobs/${'c'.repeat(64)}.png)`,
        workingDir: path.join(path.sep, 'workdir'),
        sessionId: 'session-6',
        existingAbsPaths: [alias],
      },
      deps,
    );

    expect(realpath).toHaveBeenCalledWith(alias);
    expect(result).toEqual({ absPaths: [], text: '图片' });
    expect(deps.ingest).not.toHaveBeenCalled();
  });
});

describe('materializeLocalMarkdownFiles', () => {
  it('accepts real files inside workingDir, dedupes them, and removes internal URLs', async () => {
    const workingDir = await makeTempRoot();
    const reportPath = path.join(workingDir, 'report.pdf');
    await fs.writeFile(reportPath, '%PDF-1.4');
    const url = `xdt-file://${reportPath}`;
    const result = await materializeLocalMarkdownFiles(
      {
        text: `ready\n[report](${url})\n[duplicate](${url})`,
        workingDir,
      },
    );

    tempRoots.push(...result.tempDirs);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].absPath).not.toBe(await fs.realpath(reportPath));
    expect(result.files[0].displayName).toBe('report');
    await expect(fs.readFile(result.files[0].absPath, 'utf8')).resolves.toBe('%PDF-1.4');
    expect(result.text).toBe('ready\nreport\nduplicate');
  });

  it('uploads from an immutable staged copy after the source path changes', async () => {
    const workingDir = await makeTempRoot();
    const reportPath = path.join(workingDir, 'report.txt');
    await fs.writeFile(reportPath, 'approved content');

    const result = await materializeLocalMarkdownFiles({
      text: `[report](xdt-file://${reportPath})`,
      workingDir,
    });
    tempRoots.push(...result.tempDirs);
    await fs.writeFile(reportPath, 'replaced secret');

    expect(result.files).toHaveLength(1);
    await expect(fs.readFile(result.files[0].absPath, 'utf8')).resolves.toBe('approved content');
  });

  it('materializes SSH workdir attachments through the remote file service', async () => {
    const cacheRoot = await makeTempRoot();
    const cachePath = path.join(cacheRoot, 'remote-cache.bin');
    await fs.writeFile(cachePath, 'remote report');
    remoteFileMocks.materializeSshRemoteFile.mockResolvedValue({
      ok: true,
      cachePath,
      size: 13,
      relPath: 'report.txt',
    });

    const result = await materializeLocalMarkdownFiles({
      text: '[report](xdt-file:///srv/project/report.txt)',
      workingDir: '/srv/project',
      remoteHostId: 'ssh-host-1',
    });
    tempRoots.push(...result.tempDirs);

    expect(remoteFileMocks.materializeSshRemoteFile).toHaveBeenCalledWith(
      { remoteHostId: 'ssh-host-1', workdir: '/srv/project' },
      '/srv/project/report.txt',
      100 * 1024 * 1024,
    );
    expect(result.files).toHaveLength(1);
    await expect(fs.readFile(result.files[0].absPath, 'utf8')).resolves.toBe('remote report');
  });

  it('rejects files outside workingDir and symlink escapes without exposing their paths', async () => {
    const parent = await makeTempRoot();
    const workingDir = path.join(parent, 'work');
    const outsidePath = path.join(parent, 'secret.txt');
    const outsideDir = path.join(parent, 'outside');
    const outsideNestedPath = path.join(outsideDir, 'nested.txt');
    const symlinkPath = path.join(workingDir, 'linked.txt');
    const symlinkDir = path.join(workingDir, 'linked-dir');
    await fs.mkdir(workingDir);
    await fs.mkdir(outsideDir);
    await fs.writeFile(outsidePath, 'secret');
    await fs.writeFile(outsideNestedPath, 'nested secret');
    await fs.symlink(outsidePath, symlinkPath);
    await fs.symlink(outsideDir, symlinkDir);

    const result = await materializeLocalMarkdownFiles({
      text: `[outside](xdt-file://${outsidePath})\n[linked](xdt-file://${symlinkPath})\n[parent linked](xdt-file://${path.join(symlinkDir, 'nested.txt')})`,
      workingDir,
    });

    expect(result).toEqual({ files: [], tempDirs: [], text: 'outside\nlinked\nparent linked' });
    expect(result.text).not.toContain('xdt-file://');
    expect(result.text).not.toContain(outsidePath);
  });
});

describe('sanitizeLocalMarkdownImageRefs', () => {
  it('removes absolute and file URL image targets while preserving readable labels', () => {
    const text = [
      '![unix](/Users/private/a.png)',
      '![windows](C:\\Users\\private\\b.png)',
      '![file url](file:///Users/private/c.png)',
      '![remote](https://example.com/public.png)',
    ].join('\n');

    expect(sanitizeLocalMarkdownImageRefs(text)).toBe(
      ['unix', 'windows', 'file url', '![remote](https://example.com/public.png)'].join('\n'),
    );
  });

  it('removes angle-bracket local targets with optional Markdown titles', () => {
    const text = [
      '![unix](</Users/private/a.png> "caption")',
      '![windows](<C:\\Users\\private\\b.png> "caption")',
      '![file url](<file:///Users/private/c.png> "caption")',
    ].join('\n');

    expect(sanitizeLocalMarkdownImageRefs(text)).toBe('unix\nwindows\nfile url');
  });
});
