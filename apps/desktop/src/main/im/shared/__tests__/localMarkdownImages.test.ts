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

  it('allows one line ending between a local image destination and title', async () => {
    const workingDir = await makeTempRoot();
    const sourcePath = path.join(workingDir, 'generated.png');
    const mediaAbsPath = path.join(workingDir, 'media-store.png');
    await fs.writeFile(sourcePath, PNG_BYTES);

    await expect(
      materializeLocalMarkdownImages(
        { text: `![preview](<${sourcePath}>\n"caption")`, workingDir, sessionId: 'line-title' },
        makeDeps(mediaAbsPath),
      ),
    ).resolves.toEqual({ absPaths: [mediaAbsPath], text: 'preview' });
  });

  it('does not materialize a plain image destination with unescaped whitespace', async () => {
    const workingDir = await makeTempRoot();
    const sourcePath = path.join(workingDir, 'secret image.png');
    await fs.writeFile(sourcePath, PNG_BYTES);
    const deps = makeDeps(path.join(workingDir, 'media-store.png'));
    const text = `![示例](${sourcePath})`;

    await expect(
      materializeLocalMarkdownImages(
        { text, workingDir, sessionId: 'session-unescaped-whitespace' },
        deps,
      ),
    ).resolves.toEqual({ absPaths: [], text });
    expect(deps.ingest).not.toHaveBeenCalled();
    expect(sanitizeLocalMarkdownImageRefs(text)).toBe('示例');
  });

  it('does not treat backslash followed by whitespace as an image destination escape', async () => {
    const workingDir = await makeTempRoot();
    const sourcePath = path.join(workingDir, 'secret\\ image.png');
    const deps = makeDeps(path.join(workingDir, 'media-store.png'));
    deps.realpath = vi.fn(async (value: string) => value);
    deps.readBoundedFile = vi.fn(async () => PNG_BYTES);
    const text = `![示例](${sourcePath})`;

    await expect(
      materializeLocalMarkdownImages(
        { text, workingDir, sessionId: 'session-backslash-whitespace' },
        deps,
      ),
    ).resolves.toEqual({ absPaths: [], text });
    expect(deps.ingest).not.toHaveBeenCalled();
  });

  it('decodes Markdown punctuation escapes before reading a local image', async () => {
    const workingDir = await makeTempRoot();
    const sourcePath = path.join(workingDir, 'a(b.png');
    const mediaAbsPath = path.join(workingDir, 'media-store.png');
    await fs.writeFile(sourcePath, PNG_BYTES);
    const markdownPath = sourcePath.replace('(', '\\(');

    await expect(
      materializeLocalMarkdownImages(
        { text: `![escaped](${markdownPath})`, workingDir, sessionId: 'escaped-path' },
        makeDeps(mediaAbsPath),
      ),
    ).resolves.toEqual({ absPaths: [mediaAbsPath], text: 'escaped' });
  });

  it('redacts but does not materialize an angle destination missing its closing bracket', async () => {
    const workingDir = await makeTempRoot();
    const sourcePath = path.join(workingDir, 'private.png');
    await fs.writeFile(sourcePath, PNG_BYTES);
    const deps = makeDeps(path.join(workingDir, 'media-store.png'));
    const text = `![private](<${sourcePath})`;

    await expect(
      materializeLocalMarkdownImages(
        { text, workingDir, sessionId: 'session-malformed-angle' },
        deps,
      ),
    ).resolves.toEqual({ absPaths: [], text });
    expect(deps.ingest).not.toHaveBeenCalled();
    expect(sanitizeLocalMarkdownImageRefs(text)).toBe('private');
  });

  it('redacts but does not materialize an angle destination with an invalid tail', async () => {
    const workingDir = await makeTempRoot();
    const sourcePath = path.join(workingDir, 'private.png');
    await fs.writeFile(sourcePath, PNG_BYTES);
    const deps = makeDeps(path.join(workingDir, 'media-store.png'));
    const text = `![示例](<${sourcePath}> garbage)`;

    await expect(
      materializeLocalMarkdownImages(
        { text, workingDir, sessionId: 'session-invalid-angle-tail' },
        deps,
      ),
    ).resolves.toEqual({ absPaths: [], text });
    expect(deps.ingest).not.toHaveBeenCalled();
    expect(sanitizeLocalMarkdownImageRefs(text)).toBe('示例');
  });

  it('requires whitespace before an angle image destination title', async () => {
    const workingDir = await makeTempRoot();
    const sourcePath = path.join(workingDir, 'private.png');
    await fs.writeFile(sourcePath, PNG_BYTES);
    const deps = makeDeps(path.join(workingDir, 'media-store.png'));
    const text = `![示例](<${sourcePath}>"title")`;

    await expect(
      materializeLocalMarkdownImages(
        { text, workingDir, sessionId: 'session-angle-title-whitespace' },
        deps,
      ),
    ).resolves.toEqual({ absPaths: [], text });
    expect(deps.ingest).not.toHaveBeenCalled();
    expect(sanitizeLocalMarkdownImageRefs(text)).toBe('示例');
  });

  it('redacts but does not materialize an angle destination with an unescaped opening angle', async () => {
    const workingDir = await makeTempRoot();
    const sourcePath = path.join(workingDir, 'secret<draft.png');
    const deps = makeDeps(path.join(workingDir, 'media-store.png'));
    deps.realpath = vi.fn(async (value: string) => value);
    deps.readBoundedFile = vi.fn(async () => PNG_BYTES);
    const text = `![示例](<${sourcePath}>)`;

    await expect(
      materializeLocalMarkdownImages(
        { text, workingDir, sessionId: 'session-invalid-angle-destination' },
        deps,
      ),
    ).resolves.toEqual({ absPaths: [], text });
    expect(deps.ingest).not.toHaveBeenCalled();
    expect(sanitizeLocalMarkdownImageRefs(text)).toBe('示例');
  });

  it('materializes an angle destination containing a closing parenthesis', async () => {
    const workingDir = await makeTempRoot();
    const sourcePath = path.join(workingDir, 'private)image.png');
    await fs.writeFile(sourcePath, PNG_BYTES);
    const mediaAbsPath = path.join(workingDir, 'media-store.png');
    const deps = makeDeps(mediaAbsPath);
    const text = `![private](<${sourcePath}> "preview")`;

    await expect(
      materializeLocalMarkdownImages(
        { text, workingDir, sessionId: 'session-angle-parenthesis' },
        deps,
      ),
    ).resolves.toEqual({ absPaths: [mediaAbsPath], text: 'private' });
    expect(deps.ingest).toHaveBeenCalledTimes(1);
    expect(sanitizeLocalMarkdownImageRefs(text)).toBe('private');
  });

  it('parses an escaped closing bracket in a local image label', async () => {
    const workingDir = await makeTempRoot();
    const sourcePath = path.join(workingDir, 'generated.png');
    const mediaAbsPath = path.join(workingDir, 'media-store.png');
    await fs.writeFile(sourcePath, PNG_BYTES);
    const text = `![a\\]b](${sourcePath})`;

    await expect(
      materializeLocalMarkdownImages(
        { text, workingDir, sessionId: 'session-escaped-alt' },
        makeDeps(mediaAbsPath),
      ),
    ).resolves.toEqual({ absPaths: [mediaAbsPath], text: 'a]b' });
    expect(sanitizeLocalMarkdownImageRefs(text)).toBe('a]b');
  });

  it('materializes and redacts a local image whose label contains a soft line break', async () => {
    const workingDir = await makeTempRoot();
    const sourcePath = path.join(workingDir, 'generated.png');
    const mediaAbsPath = path.join(workingDir, 'media-store.png');
    await fs.writeFile(sourcePath, PNG_BYTES);
    const text = `![说明\n图](${sourcePath})`;

    await expect(
      materializeLocalMarkdownImages(
        { text, workingDir, sessionId: 'session-soft-break-label' },
        makeDeps(mediaAbsPath),
      ),
    ).resolves.toEqual({ absPaths: [mediaAbsPath], text: '说明\n图' });
    expect(sanitizeLocalMarkdownImageRefs(text)).toBe('说明\n图');
  });

  it('limits plain local image destinations to 32 nested parentheses', async () => {
    const workingDir = await makeTempRoot();
    const acceptedPath = path.join(
      workingDir,
      `depth-${'('.repeat(32)}accepted${')'.repeat(32)}.png`,
    );
    const rejectedPath = path.join(
      workingDir,
      `depth-${'('.repeat(33)}rejected${')'.repeat(33)}.png`,
    );
    const sequentialPath = path.join(workingDir, `depth-${'()'.repeat(33)}sequential.png`);
    const mediaAbsPath = path.join(workingDir, 'media-store.png');
    await fs.writeFile(acceptedPath, PNG_BYTES);
    await fs.writeFile(rejectedPath, PNG_BYTES);
    await fs.writeFile(sequentialPath, PNG_BYTES);

    await expect(
      materializeLocalMarkdownImages(
        {
          text: `![accepted](${acceptedPath})`,
          workingDir,
          sessionId: 'session-parenthesis-depth-32',
        },
        makeDeps(mediaAbsPath),
      ),
    ).resolves.toEqual({ absPaths: [mediaAbsPath], text: 'accepted' });

    const rejectedText = `![rejected](${rejectedPath})`;
    const rejectedDeps = makeDeps(mediaAbsPath);
    await expect(
      materializeLocalMarkdownImages(
        {
          text: rejectedText,
          workingDir,
          sessionId: 'session-parenthesis-depth-33',
        },
        rejectedDeps,
      ),
    ).resolves.toEqual({ absPaths: [], text: rejectedText });
    expect(rejectedDeps.ingest).not.toHaveBeenCalled();
    expect(sanitizeLocalMarkdownImageRefs(rejectedText)).toBe('rejected');

    await expect(
      materializeLocalMarkdownImages(
        {
          text: `![sequential](${sequentialPath})`,
          workingDir,
          sessionId: 'session-parenthesis-sequential',
        },
        makeDeps(mediaAbsPath),
      ),
    ).resolves.toEqual({ absPaths: [mediaAbsPath], text: 'sequential' });
  });

  it('materializes and redacts an outer local image whose label contains a link', async () => {
    const workingDir = await makeTempRoot();
    const sourcePath = path.join(workingDir, 'private.png');
    const mediaAbsPath = path.join(workingDir, 'media-store.png');
    await fs.writeFile(sourcePath, PNG_BYTES);
    const deps = makeDeps(mediaAbsPath);
    const text = `![outer [inner](https://example.com)](${sourcePath})`;

    await expect(
      materializeLocalMarkdownImages(
        { text, workingDir, sessionId: 'session-linked-label' },
        deps,
      ),
    ).resolves.toEqual({
      absPaths: [mediaAbsPath],
      text: 'outer [inner](https://example.com)',
    });
    expect(sanitizeLocalMarkdownImageRefs(text)).toBe('outer [inner](https://example.com)');
  });

  it('does not materialize an escaped local image marker but still redacts its path', async () => {
    const workingDir = await makeTempRoot();
    const sourcePath = path.join(workingDir, 'private.png');
    await fs.writeFile(sourcePath, PNG_BYTES);
    const deps = makeDeps(path.join(workingDir, 'media-store.png'));
    const escaped = `\\![private](${sourcePath})`;

    await expect(
      materializeLocalMarkdownImages(
        { text: escaped, workingDir, sessionId: 'session-escaped-marker' },
        deps,
      ),
    ).resolves.toEqual({ absPaths: [], text: escaped });
    expect(deps.ingest).not.toHaveBeenCalled();
    expect(sanitizeLocalMarkdownImageRefs(escaped)).toBe('\\private');
  });

  it('materializes an image marker preceded by an even number of backslashes', async () => {
    const workingDir = await makeTempRoot();
    const sourcePath = path.join(workingDir, 'image.png');
    const mediaAbsPath = path.join(workingDir, 'media-store.png');
    await fs.writeFile(sourcePath, PNG_BYTES);

    await expect(
      materializeLocalMarkdownImages(
        {
          text: `\\\\![image](${sourcePath})`,
          workingDir,
          sessionId: 'session-even-escape',
        },
        makeDeps(mediaAbsPath),
      ),
    ).resolves.toEqual({ absPaths: [mediaAbsPath], text: '\\\\image' });
  });

  it('captures a balanced parenthesized Markdown title without leaving a trailing bracket', async () => {
    const workingDir = await makeTempRoot();
    const sourcePath = path.join(workingDir, 'generated.png');
    const mediaAbsPath = path.join(workingDir, 'media-store.png');
    await fs.writeFile(sourcePath, PNG_BYTES);
    const deps = makeDeps(mediaAbsPath);

    await expect(
      materializeLocalMarkdownImages(
        {
          text: `![preview](${sourcePath} (caption))`,
          workingDir,
          sessionId: 'session-parenthesized-title',
        },
        deps,
      ),
    ).resolves.toEqual({ absPaths: [mediaAbsPath], text: 'preview' });
  });

  it('ignores a closing parenthesis inside a quoted image title', async () => {
    const workingDir = await makeTempRoot();
    const sourcePath = path.join(workingDir, 'titled.png');
    const mediaAbsPath = path.join(workingDir, 'media-store.png');
    await fs.writeFile(sourcePath, PNG_BYTES);
    const deps = makeDeps(mediaAbsPath);
    const text = `![titled](${sourcePath} "第 1) 版")`;

    await expect(
      materializeLocalMarkdownImages(
        { text, workingDir, sessionId: 'session-title-parenthesis' },
        deps,
      ),
    ).resolves.toEqual({ absPaths: [mediaAbsPath], text: 'titled' });
  });

  it('materializes a local image target with multiple balanced parenthesis levels', async () => {
    const workingDir = await makeTempRoot();
    const sourcePath = path.join(workingDir, 'chart(a(b)c).png');
    const mediaAbsPath = path.join(workingDir, 'media-store.png');
    await fs.writeFile(sourcePath, PNG_BYTES);

    await expect(
      materializeLocalMarkdownImages(
        {
          text: `![nested](${sourcePath})`,
          workingDir,
          sessionId: 'session-nested-parentheses',
        },
        makeDeps(mediaAbsPath),
      ),
    ).resolves.toEqual({ absPaths: [mediaAbsPath], text: 'nested' });
  });

  it('leaves local image examples inside Markdown code untouched and unsent', async () => {
    const workingDir = await makeTempRoot();
    const sourcePath = path.join(workingDir, 'private.png');
    const mediaAbsPath = path.join(workingDir, 'media-store.png');
    await fs.writeFile(sourcePath, PNG_BYTES);
    const deps = makeDeps(mediaAbsPath);
    const text = [
      `\`![inline](${sourcePath})\``,
      '```md',
      `![fenced](${sourcePath})`,
      '```',
      '> ~~~md',
      `> ![quoted](${sourcePath})`,
      '> ~~~',
      '',
      `    ![indented](${sourcePath})`,
    ].join('\n');

    await expect(
      materializeLocalMarkdownImages({ text, workingDir, sessionId: 'session-code-example' }, deps),
    ).resolves.toEqual({ absPaths: [], text });
    expect(sanitizeLocalMarkdownImageRefs(text)).toBe(text);
    expect(deps.ingest).not.toHaveBeenCalled();
  });

  it('leaves local image examples inside blockquote indented code untouched and unsent', async () => {
    const workingDir = await makeTempRoot();
    const sourcePath = path.join(workingDir, 'private.png');
    await fs.writeFile(sourcePath, PNG_BYTES);
    const deps = makeDeps(path.join(workingDir, 'media-store.png'));
    const text = `>     ![private](${sourcePath})`;

    await expect(
      materializeLocalMarkdownImages(
        { text, workingDir, sessionId: 'session-quoted-indented-code' },
        deps,
      ),
    ).resolves.toEqual({ absPaths: [], text });
    expect(deps.ingest).not.toHaveBeenCalled();
    expect(sanitizeLocalMarkdownImageRefs(text)).toBe(text);
  });

  it('leaves local image examples inside raw HTML blocks untouched and unsent', async () => {
    const workingDir = await makeTempRoot();
    const sourcePath = path.join(workingDir, 'private.png');
    await fs.writeFile(sourcePath, PNG_BYTES);
    const deps = makeDeps(path.join(workingDir, 'media-store.png'));
    const text = `<pre>\n![private](${sourcePath})\n</pre>`;

    await expect(
      materializeLocalMarkdownImages(
        { text, workingDir, sessionId: 'session-html-code' },
        deps,
      ),
    ).resolves.toEqual({ absPaths: [], text });
    expect(deps.ingest).not.toHaveBeenCalled();
  });

  it('materializes a local image in a four-space list continuation', async () => {
    const workingDir = await makeTempRoot();
    const sourcePath = path.join(workingDir, 'chart.png');
    const mediaAbsPath = path.join(workingDir, 'media-store.png');
    await fs.writeFile(sourcePath, PNG_BYTES);

    await expect(
      materializeLocalMarkdownImages(
        {
          text: `- 输出：\n    ![chart](${sourcePath})`,
          workingDir,
          sessionId: 'session-list-continuation',
        },
        makeDeps(mediaAbsPath),
      ),
    ).resolves.toEqual({ absPaths: [mediaAbsPath], text: '- 输出：\n    chart' });
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

  it('rejects a parent symlink swap at the bounded read boundary', async () => {
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
    const readBoundedFile = deps.readBoundedFile;
    deps.readBoundedFile = vi.fn(async (value, maxBytes, containWithin) => {
      await fs.rename(sourceDir, `${sourceDir}-original`);
      await fs.symlink(outsideDir, sourceDir);
      return readBoundedFile(value, maxBytes, containWithin);
    });

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
      // If canonical dedupe regresses, keep the fallback path viable so the
      // assertion fails by appending a duplicate instead of by missing bytes.
      readBoundedFile: vi.fn(async () => PNG_BYTES),
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
    const result = await materializeLocalMarkdownFiles({
      text: `ready\n[report](${url})\n[duplicate](${url})`,
      workingDir,
    });

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

  it('does not materialize an xdt-file destination with unescaped whitespace', async () => {
    const workingDir = await makeTempRoot();
    const reportPath = path.join(workingDir, 'secret report.pdf');
    await fs.writeFile(reportPath, '%PDF-1.4');

    for (const text of [
      `[示例](xdt-file://${reportPath})`,
      `[示例](xdt-file://${reportPath} "title")`,
    ]) {
      const result = await materializeLocalMarkdownFiles({ text, workingDir });

      expect(result.files).toEqual([]);
      expect(result.tempDirs).toEqual([]);
      expect(result.text).not.toContain('xdt-file://');
      expect(result.text).not.toContain(reportPath);
    }
  });

  it('sanitizes control characters, path separators, and oversized attachment names', async () => {
    const workingDir = await makeTempRoot();
    const reportPath = path.join(workingDir, 'report.txt');
    await fs.writeFile(reportPath, 'approved content');
    const unsafeLabel = `../private\\report\t\u202esecret${'x'.repeat(200)}`;

    const result = await materializeLocalMarkdownFiles({
      text: `[${unsafeLabel}](xdt-file://${reportPath})`,
      workingDir,
    });
    tempRoots.push(...result.tempDirs);

    const displayName = result.files[0]?.displayName ?? '';
    expect(displayName).not.toMatch(/[\\/]/);
    expect(Array.from(displayName).every((char) => char.charCodeAt(0) > 0x1f)).toBe(true);
    expect(displayName).not.toContain('\u202e');
    expect(Array.from(displayName)).toHaveLength(120);
    expect(result.text).toBe(displayName);
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

  it('leaves xdt-file examples inside Markdown code untouched and unsent', async () => {
    const workingDir = await makeTempRoot();
    const reportPath = path.join(workingDir, 'secret.pdf');
    await fs.writeFile(reportPath, '%PDF-1.4');
    const text = [
      `\`[inline](xdt-file://${reportPath})\``,
      '```md',
      `[fenced](xdt-file://${reportPath})`,
      '```',
    ].join('\n');

    await expect(materializeLocalMarkdownFiles({ text, workingDir })).resolves.toEqual({
      files: [],
      tempDirs: [],
      text,
    });
  });

  it('leaves an indented xdt-file example after a heading untouched and unsent', async () => {
    const workingDir = await makeTempRoot();
    const reportPath = path.join(workingDir, 'secret.pdf');
    await fs.writeFile(reportPath, '%PDF-1.4');
    const text = `# 标题\n    [示例](xdt-file://${reportPath})`;

    await expect(materializeLocalMarkdownFiles({ text, workingDir })).resolves.toEqual({
      files: [],
      tempDirs: [],
      text,
    });
  });

  it('redacts a bare xdt-file URL without attempting to upload it', async () => {
    const workingDir = await makeTempRoot();
    const text = 'Download xdt-file:///Users/alice/private.pdf now';

    await expect(materializeLocalMarkdownFiles({ text, workingDir })).resolves.toEqual({
      files: [],
      tempDirs: [],
      text: 'Download 附件 now',
    });
  });

  it('materializes an angle-bracket xdt-file destination and removes its title', async () => {
    const workingDir = await makeTempRoot();
    const reportPath = path.join(workingDir, 'report.pdf');
    await fs.writeFile(reportPath, '%PDF-1.4');
    const result = await materializeLocalMarkdownFiles({
      text: `[report](<xdt-file://${reportPath}> "download")`,
      workingDir,
    });
    tempRoots.push(...result.tempDirs);

    expect(result.files).toHaveLength(1);
    expect(result.text).toBe('report');
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

  it('removes a plain local target with a parenthesized title as one complete image', () => {
    expect(sanitizeLocalMarkdownImageRefs('![preview](/Users/private/a.png (caption))')).toBe(
      'preview',
    );
  });

  it('redacts a local target with multiple balanced parenthesis levels', () => {
    expect(
      sanitizeLocalMarkdownImageRefs('![private](/Users/alice/a(b(c)d).png)'),
    ).toBe('private');
  });

  it('fail-closes incomplete local image syntax without touching code examples', () => {
    const text = [
      '![private](/Users/alice/private/output.png',
      '![angle](<file:///Users/alice/private/angle.png',
      '`![inline](/Users/alice/private/inline.png`',
    ].join('\n');

    expect(sanitizeLocalMarkdownImageRefs(text)).toBe(
      ['private', 'angle', '`![inline](/Users/alice/private/inline.png`'].join('\n'),
    );
  });

  it('redacts a complete local image destination beyond the materialization limit', () => {
    const localPath = `/Users/alice/private/${'a'.repeat(5_000)}.png`;

    expect(sanitizeLocalMarkdownImageRefs(`before ![private](${localPath}) after`)).toBe(
      'before private after',
    );
  });

  it('redacts the whole line for an incomplete local destination beyond the materialization limit', () => {
    const localPath = `/Users/alice/private/${'b'.repeat(5_000)}.png`;

    expect(sanitizeLocalMarkdownImageRefs(`before ![private](${localPath}`)).toBe(
      'before private',
    );
  });

  it('redacts local image targets after labels beyond the materialization limit', () => {
    const label = `private-${'c'.repeat(600)}`;
    const localPath = '/Users/alice/private/output.png';

    expect(sanitizeLocalMarkdownImageRefs(`![${label}](${localPath})`)).toBe(label);
  });

  it('redacts file URL schemes case-insensitively', () => {
    expect(
      sanitizeLocalMarkdownImageRefs('![private](FILE:///Users/alice/private/output.png)'),
    ).toBe('private');
  });

  it('does not let an outer remote target hide a nested local image', () => {
    expect(
      sanitizeLocalMarkdownImageRefs(
        '![outer](https://invalid ![private](/Users/alice/private/output.png))',
      ),
    ).not.toContain('/Users/alice/private/output.png');
  });

  it('fail-closes an outer local target before a nested remote image', () => {
    const text =
      '![outer](/Users/alice/private/secret![inner](https://example.com/image.png))';

    expect(sanitizeLocalMarkdownImageRefs(text)).toBe('outer');
  });
});
