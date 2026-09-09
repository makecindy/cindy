import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  relativeOutputParentPath,
  type DocsOutputWriteRequest,
} from '../docsOutputWriterProtocol.js';
import {
  relativePathSegments,
  runDocsOutputWriteForTest,
  sameRelativePath,
} from '../docsOutputWriterUtilityProcess.js';

let root: string;
const cleanup: string[] = [];
const utilityModuleUrl = pathToFileURL(
  path.resolve(process.cwd(), 'src/main/doc-tools/docsOutputWriterUtilityProcess.ts'),
).href;
const tsxLoader = createRequire(import.meta.url).resolve('tsx');

beforeEach(async () => {
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cindy-docs-writer-'));
  cleanup.push(root);
});

afterEach(async () => {
  vi.restoreAllMocks();
  while (cleanup.length > 0) {
    await fs.promises.rm(cleanup.pop()!, { recursive: true, force: true });
  }
});

async function request(
  targetName: string,
  data: string,
  overwrite: boolean,
  parent = root,
): Promise<DocsOutputWriteRequest> {
  const stat = await fs.promises.lstat(parent, { bigint: true });
  const rootStat = await fs.promises.lstat(root, { bigint: true });
  const rootRealPath = await fs.promises.realpath(root);
  const parentRealPath = await fs.promises.realpath(parent);
  return {
    expectedRoot: {
      realPath: rootRealPath,
      dev: rootStat.dev,
      ino: rootStat.ino,
    },
    expectedParent: {
      realPath: parentRealPath,
      dev: stat.dev,
      ino: stat.ino,
    },
    parentRelativePath: path.relative(rootRealPath, parentRealPath),
    targetName,
    data: Buffer.from(data),
    overwrite,
  };
}

async function missingParentRequest(
  targetName: string,
  data: string,
): Promise<DocsOutputWriteRequest> {
  const rootStat = await fs.promises.lstat(root, { bigint: true });
  const rootRealPath = await fs.promises.realpath(root);
  return {
    expectedRoot: { realPath: rootRealPath, dev: rootStat.dev, ino: rootStat.ino },
    expectedParent: null,
    parentRelativePath: 'nested/reports',
    targetName,
    data: Buffer.from(data),
    overwrite: false,
  };
}

describe('docs output cwd-bound writer', () => {
  it('derives output parents from the lexical session root before realpath canonicalization', () => {
    const lexicalRoot = path.join(root, 'session-root-alias');
    expect(relativeOutputParentPath(lexicalRoot, path.join(lexicalRoot, 'documents'))).toBe(
      'documents',
    );
    expect(relativeOutputParentPath(lexicalRoot, path.join(root, 'outside'))).toBeNull();
  });

  it('uses Windows case-insensitive semantics for relative parent paths', () => {
    expect(sameRelativePath('Documents/Reports', 'documents\\reports', 'win32')).toBe(true);
    expect(sameRelativePath('Documents/Reports', 'documents\\reports', 'darwin')).toBe(false);
  });

  it('normalizes only the current platform separators when walking output parents', () => {
    expect(relativePathSegments('nested/reports', 'win32')).toEqual(['nested', 'reports']);
    expect(relativePathSegments('nested\\reports', 'win32')).toEqual(['nested', 'reports']);
    expect(relativePathSegments('reports\\2026', 'darwin')).toEqual(['reports\\2026']);
  });

  it.runIf(process.platform !== 'win32')(
    'keeps backslashes as literal output-directory characters on POSIX',
    async () => {
      const rootStat = await fs.promises.lstat(root, { bigint: true });
      const rootRealPath = await fs.promises.realpath(root);
      const pending: DocsOutputWriteRequest = {
        expectedRoot: { realPath: rootRealPath, dev: rootStat.dev, ino: rootStat.ino },
        expectedParent: null,
        parentRelativePath: 'reports\\2026',
        targetName: 'report.bin',
        data: Buffer.from('literal-backslash'),
        overwrite: false,
      };

      await runDocsOutputWriteForTest(pending, root);
      expect(
        await fs.promises.readFile(path.join(root, 'reports\\2026', 'report.bin'), 'utf8'),
      ).toBe('literal-backslash');
      await expect(fs.promises.stat(path.join(root, 'reports'))).rejects.toThrow();
    },
  );

  it('creates exclusively and never truncates an existing file by default', async () => {
    const first = await request('report.bin', 'one', false);
    await runDocsOutputWriteForTest(first, root);
    await expect(
      runDocsOutputWriteForTest(await request('report.bin', 'two', false), root),
    ).rejects.toMatchObject({ code: 'FILE_EXISTS' });
    expect(await fs.promises.readFile(path.join(root, 'report.bin'), 'utf8')).toBe('one');
    expect((await fs.promises.readdir(root)).some((name) => name.includes('.cindy-docs-'))).toBe(
      false,
    );
  });

  it('does not expose a partial target when the first write fails', async () => {
    const originalOpen = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, 'open').mockImplementationOnce(async (file, flags, mode) => {
      const handle = await originalOpen(file, flags, mode);
      vi.spyOn(handle, 'writeFile').mockImplementationOnce(async (data) => {
        await handle.write(Buffer.from(data as Uint8Array).subarray(0, 3));
        throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      });
      return handle;
    });

    await expect(
      runDocsOutputWriteForTest(await request('report.bin', 'partial-data', false), root),
    ).rejects.toMatchObject({ code: 'ENOSPC' });
    await expect(fs.promises.stat(path.join(root, 'report.bin'))).rejects.toThrow();
    expect((await fs.promises.readdir(root)).some((name) => name.includes('.cindy-docs-'))).toBe(
      false,
    );
  });

  it.each(['ENOTSUP', 'EPERM'])(
    'fails closed without exposing a target when hard-link publication returns %s',
    async (code) => {
      vi.spyOn(fs.promises, 'link').mockRejectedValueOnce(
        Object.assign(new Error('hard links unsupported'), { code }),
      );

      await expect(
        runDocsOutputWriteForTest(await request('report.bin', 'not-published', false), root),
      ).rejects.toMatchObject({ code: 'ATOMIC_PUBLISH_UNSUPPORTED' });
      await expect(fs.promises.stat(path.join(root, 'report.bin'))).rejects.toThrow();
      expect((await fs.promises.readdir(root)).some((name) => name.includes('.cindy-docs-'))).toBe(
        false,
      );
    },
  );

  it('creates missing parents inside the anchored session root', async () => {
    await runDocsOutputWriteForTest(await missingParentRequest('report.bin', 'nested'), root);
    expect(await fs.promises.readFile(path.join(root, 'nested/reports/report.bin'), 'utf8')).toBe(
      'nested',
    );
  });

  it('atomically replaces an existing regular file', async () => {
    await fs.promises.writeFile(path.join(root, 'report.bin'), 'old');
    await runDocsOutputWriteForTest(await request('report.bin', 'new', true), root);
    expect(await fs.promises.readFile(path.join(root, 'report.bin'), 'utf8')).toBe('new');
    expect((await fs.promises.readdir(root)).some((name) => name.includes('.cindy-docs-'))).toBe(
      false,
    );
  });

  it.each(['EEXIST', 'EPERM'])(
    'fails closed without moving the original target when atomic replace returns %s',
    async (code) => {
      await fs.promises.writeFile(path.join(root, 'report.bin'), 'old');
      vi.spyOn(fs.promises, 'rename').mockRejectedValueOnce(
        Object.assign(new Error('replace denied'), { code }),
      );

      await expect(
        runDocsOutputWriteForTest(await request('report.bin', 'new', true), root),
      ).rejects.toMatchObject({ code: 'ATOMIC_PUBLISH_UNSUPPORTED' });
      expect(await fs.promises.readFile(path.join(root, 'report.bin'), 'utf8')).toBe('old');
      expect((await fs.promises.readdir(root)).some((name) => name.includes('.cindy-docs-'))).toBe(
        false,
      );
    },
  );

  it('rejects a parent path rebound to an outside symlink before the final operation', async () => {
    const safe = path.join(root, 'safe');
    const moved = path.join(root, 'safe-original');
    const outside = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cindy-docs-outside-'));
    cleanup.push(outside);
    await fs.promises.mkdir(safe);
    const pending = await request('report.bin', 'blocked', false, safe);
    await fs.promises.rename(safe, moved);
    await fs.promises.symlink(outside, safe, process.platform === 'win32' ? 'junction' : 'dir');

    await expect(runDocsOutputWriteForTest(pending, root)).rejects.toMatchObject({
      code: 'PATH_NOT_ALLOWED',
    });
    await expect(fs.promises.stat(path.join(outside, 'report.bin'))).rejects.toThrow();
  });

  it.runIf(process.platform !== 'win32')(
    'binds create and overwrite operations to the verified parent inode in the utility process',
    async () => {
      for (const overwrite of [false, true]) {
        const safe = path.join(root, overwrite ? 'overwrite-safe' : 'create-safe');
        const moved = `${safe}-original`;
        const outside = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cindy-docs-outside-'));
        cleanup.push(outside);
        await fs.promises.mkdir(safe);
        if (overwrite) await fs.promises.writeFile(path.join(safe, 'report.bin'), 'old');

        const probe = spawnSync(
          process.execPath,
          [
            '--import',
            tsxLoader,
            '-e',
            `
const fs = (await import('node:fs')).default;
const path = (await import('node:path')).default;
const writerModule = await import(process.env.CINDY_WRITER_MODULE);
const { runDocsOutputWrite } = writerModule.default ?? writerModule;
const root = process.env.CINDY_WRITER_ROOT;
const safe = process.env.CINDY_WRITER_SAFE;
const moved = process.env.CINDY_WRITER_MOVED;
const outside = process.env.CINDY_WRITER_OUTSIDE;
const overwrite = process.env.CINDY_WRITER_OVERWRITE === 'true';
const rootStat = await fs.promises.lstat(root, { bigint: true });
const parentStat = await fs.promises.lstat(safe, { bigint: true });
const request = {
  expectedRoot: { realPath: await fs.promises.realpath(root), dev: rootStat.dev, ino: rootStat.ino },
  expectedParent: { realPath: await fs.promises.realpath(safe), dev: parentStat.dev, ino: parentStat.ino },
  parentRelativePath: path.relative(root, safe),
  targetName: 'report.bin',
  data: Buffer.from(overwrite ? 'new' : 'bound'),
  overwrite,
};
const originalOpen = fs.promises.open.bind(fs.promises);
fs.promises.open = async (...args) => {
  fs.promises.open = originalOpen;
  await fs.promises.rename(safe, moved);
  await fs.promises.symlink(outside, safe, 'dir');
  return originalOpen(...args);
};
process.chdir(root);
let code = 'NO_ERROR';
try { await runDocsOutputWrite(request); } catch (error) { code = error?.code || String(error); }
const outsideExists = fs.existsSync(path.join(outside, 'report.bin'));
const movedValue = fs.existsSync(path.join(moved, 'report.bin'))
  ? await fs.promises.readFile(path.join(moved, 'report.bin'), 'utf8')
  : null;
process.stdout.write(JSON.stringify({ code, outsideExists, movedValue }));
`,
          ],
          {
            cwd: root,
            encoding: 'utf8',
            env: {
              ...process.env,
              CINDY_WRITER_MODULE: utilityModuleUrl,
              CINDY_WRITER_ROOT: root,
              CINDY_WRITER_SAFE: safe,
              CINDY_WRITER_MOVED: moved,
              CINDY_WRITER_OUTSIDE: outside,
              CINDY_WRITER_OVERWRITE: String(overwrite),
            },
          },
        );
        expect(probe.status, probe.stderr || String(probe.error ?? '')).toBe(0);
        expect(JSON.parse(probe.stdout)).toEqual({
          code: 'PATH_NOT_ALLOWED',
          outsideExists: false,
          movedValue: overwrite ? 'old' : null,
        });
      }
    },
  );

  it('anchors the final write at the session root when the parent inode moves away', async () => {
    const safe = path.join(root, 'safe');
    const moved = path.join(root, 'safe-original');
    await fs.promises.mkdir(safe);
    const pending = await request('report.bin', 'blocked', false, safe);
    await fs.promises.rename(safe, moved);

    await expect(runDocsOutputWriteForTest(pending, root)).rejects.toMatchObject({
      code: 'PATH_NOT_ALLOWED',
    });
    await expect(fs.promises.stat(path.join(moved, 'report.bin'))).rejects.toThrow();
  });
});
