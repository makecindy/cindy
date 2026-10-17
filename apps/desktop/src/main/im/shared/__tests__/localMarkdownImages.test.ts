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
    materialize: vi.fn(async (_sessionId: string, text: string) => text),
    resolveMediaUrl: vi.fn(() => ({ absPath: mediaAbsPath })),
  };
}
afterEach(async () => {
  for (const root of tempRoots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe('materializeLocalMarkdownImages', () => {
  it('uses the common importer before collecting and deduplicating managed images', async () => {
    const workingDir = await makeTempRoot();
    const media = path.join(workingDir, 'stored.png');
    await fs.writeFile(media, PNG_BYTES);
    const deps = makeDeps(media);
    const text = `完成\n![测试图片](${workingDir}/generated.png)`;
    deps.materialize.mockResolvedValue(
      '完成\n![测试图片](cindy-media://blobs/test.png)\n![重复](cindy-media://blobs/test.png)',
    );
    expect(
      await materializeLocalMarkdownImages({ text, workingDir, sessionId: 'session-1' }, deps),
    ).toEqual({
      absPaths: [await fs.realpath(media)],
      text: '完成\n测试图片\n重复',
    });
    expect(deps.materialize).toHaveBeenCalledWith('session-1', text);
  });

  it('does not fall back to reading local paths when the common importer rejects them', async () => {
    const workingDir = await makeTempRoot();
    const deps = makeDeps(path.join(workingDir, 'unused.png'));
    deps.realpath = vi.fn(deps.realpath);
    const text = `![outside](${workingDir}/outside.png)\n![scratch](xdt-image:///private/tmp/other-task.png)`;
    expect(
      await materializeLocalMarkdownImages({ text, workingDir, sessionId: 's' }, deps),
    ).toEqual({
      absPaths: [],
      text: 'outside\nscratch\n\n有 2 张图片未能作为附件发送。',
    });
    expect(deps.realpath).not.toHaveBeenCalled();
  });

  it('reports omitted images at the attachment limit without exposing internal URLs', async () => {
    const workingDir = await makeTempRoot();
    const first = path.join(workingDir, 'first.png');
    const second = path.join(workingDir, 'second.png');
    await fs.writeFile(first, PNG_BYTES);
    await fs.writeFile(second, PNG_BYTES);
    const deps = makeDeps(first);
    deps.resolveMediaUrl.mockImplementation((url?: string) => ({
      absPath: url?.includes('second') ? second : first,
    }));
    const result = await materializeLocalMarkdownImages(
      {
        text: '![first](cindy-media://blobs/first.png)\n![second](cindy-media://blobs/second.png)',
        workingDir,
        sessionId: 's',
        maxImages: 1,
      },
      deps,
    );
    expect(result).toEqual({
      absPaths: [await fs.realpath(first)],
      text: 'first\nsecond\n\n有 1 张图片未能作为附件发送。',
    });
  });

  it('rejects non-image bytes in managed storage', async () => {
    const workingDir = await makeTempRoot();
    const media = path.join(workingDir, 'fake.png');
    await fs.writeFile(media, 'not an image');
    expect(
      await materializeLocalMarkdownImages(
        {
          text: '![fake](cindy-media://blobs/test.png)',
          workingDir,
          sessionId: 's',
        },
        makeDeps(media),
      ),
    ).toEqual({ absPaths: [], text: 'fake\n\n有 1 张图片未能作为附件发送。' });
  });

  it('leaves examples in code and remote image links alone', async () => {
    const text = '`![example](/tmp/a.png)`\n\n![web](https://example.org/a.png)';
    const deps = makeDeps('/unused');
    expect(
      await materializeLocalMarkdownImages({ text, workingDir: '/work', sessionId: 's' }, deps),
    ).toEqual({ absPaths: [], text });
    expect(deps.resolveMediaUrl).not.toHaveBeenCalled();
  });

  it('normalizes existing tool-result paths before deduplication', async () => {
    const canonical = path.join(path.sep, 'canonical', 'store', 'a.png');
    const alias = path.join(path.sep, 'alias', 'store', 'a.png');
    const realpath = vi.fn(async (value: string) => (value === alias ? canonical : value));
    const deps = {
      ...makeDeps(alias),
      realpath,
      stat: vi.fn(async () => ({ isFile: () => true, size: PNG_BYTES.length })),
      readFile: async () => PNG_BYTES,
    };
    expect(
      await materializeLocalMarkdownImages(
        {
          text: '![图片](cindy-media://blobs/test.png)',
          workingDir: '/work',
          sessionId: 's',
          existingAbsPaths: [alias],
        },
        deps,
      ),
    ).toEqual({ absPaths: [], text: '图片' });
    expect(realpath).toHaveBeenCalledWith(alias);
    expect(deps.stat).not.toHaveBeenCalled();
  });
});
