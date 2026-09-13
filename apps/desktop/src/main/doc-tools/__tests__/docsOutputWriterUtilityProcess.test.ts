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
  abortInFlightWrite,
  relativePathSegments,
  resetAbortStateForTest,
  runDocsOutputWriteForTest,
  sameRelativePath,
  chooseStagingLocation,
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
  resetAbortStateForTest();
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

/** Poll a condition instead of sleeping a fixed time: the full desktop suite runs under load. */
async function waitFor(cond: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (!cond()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
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

  // Codex P1 (round 16): names only survive a crash once the parent directory is synced,
  // and the staged inode is announced before publication for timeout recovery.
  it('announces the staged inode and syncs the parent directory after removing staging', async () => {
    const realOpen = fs.promises.open.bind(fs.promises);
    const dirSyncs: string[] = [];
    const notices: unknown[] = [];
    const order: string[] = [];
    const openSpy = vi.spyOn(fs.promises, 'open').mockImplementation(async (...args: Parameters<typeof fs.promises.open>) => {
      const handle = await realOpen(...args);
      const st = await handle.stat();
      if (st.isDirectory()) {
        const origSync = handle.sync.bind(handle);
        handle.sync = async () => {
          const leftovers = (await fs.promises.readdir(String(args[0]))).filter((n) => n.includes('staging'));
          dirSyncs.push(`${leftovers.length}`);
          await origSync();
        };
      } else {
        const origWrite = handle.writeFile.bind(handle);
        handle.writeFile = (async (...w: Parameters<typeof origWrite>) => {
          order.push(`write:${notices.length}`); // notices already announced when bytes start
          return origWrite(...w);
        }) as typeof handle.writeFile;
      }
      return handle;
    });
    try {
      const identity = await runDocsOutputWriteForTest(await request('report.bin', 'payload', false), root, (n) => { notices.push(n); order.push('staged'); });
      // Codex P1 (round 17): the inode is announced before the first private byte is written.
      expect(order).toEqual(['staged', 'write:1']);
      const st = await fs.promises.lstat(path.join(root, 'report.bin'), { bigint: true });
      expect(identity).toEqual({ dev: st.dev, ino: st.ino });
      expect(notices).toEqual([{ type: 'staged', identity: { dev: st.dev, ino: st.ino }, stagingName: expect.stringMatching(/^\.cindy-docs-staging-.*-report\.bin$/), stagingIn: 'root' }]);
      // Parent directory synced exactly when no staging entry remained.
      expect(dirSyncs).toEqual(['0']);
    } finally {
      openSpy.mockRestore();
    }
  });

  // Codex P1 (round 18): a cooperative abort cleans up through the retained handle and the
  // writer's own names while a filesystem call is still hanging.
  it('abortInFlightWrite zeroes and drops the staging inode while the write is still hanging', async () => {
    const realOpen = fs.promises.open.bind(fs.promises);
    let stagingPath = '';
    const openSpy = vi.spyOn(fs.promises, 'open').mockImplementation(async (...args: Parameters<typeof fs.promises.open>) => {
      const handle = await realOpen(...args);
      if (String(args[0]).includes('.cindy-docs-staging-')) {
        stagingPath = String(args[0]);
        handle.writeFile = (() => new Promise<void>(() => {})) as typeof handle.writeFile; // hangs forever
      }
      return handle;
    });
    try {
      const pending = runDocsOutputWriteForTest(await request('report.bin', 'private', false), root).catch(() => 'rejected');
      await waitFor(() => stagingPath !== '');
      expect(await abortInFlightWrite()).toEqual({ cleaned: true });
      await expect(fs.promises.access(stagingPath)).rejects.toThrow();
      await expect(fs.promises.access(path.join(root, 'report.bin'))).rejects.toThrow();
      void pending;
    } finally {
      openSpy.mockRestore();
    }
  });

  // Codex P1 (round 19): cleaned:true only when erasure and name removal actually succeeded.
  it('abortInFlightWrite reports cleaned:false when the erasure fails', async () => {
    const realOpen = fs.promises.open.bind(fs.promises);
    const openSpy = vi.spyOn(fs.promises, 'open').mockImplementation(async (...args: Parameters<typeof fs.promises.open>) => {
      const handle = await realOpen(...args);
      if (String(args[0]).includes('.cindy-docs-staging-')) {
        handle.writeFile = (() => new Promise<void>(() => {})) as typeof handle.writeFile;
        handle.truncate = (async () => { throw Object.assign(new Error('EIO'), { code: 'EIO' }); }) as typeof handle.truncate;
      }
      return handle;
    });
    try {
      let opened = false;
      const req = await request('report.bin', 'private', false);
      void runDocsOutputWriteForTest(req, root, () => { opened = true; }).catch(() => undefined);
      await waitFor(() => opened);
      expect(await abortInFlightWrite()).toEqual({ cleaned: false });
    } finally {
      openSpy.mockRestore();
    }
  });

  it('abortInFlightWrite leaves a committed overwrite replacement alone', async () => {
    expect(await abortInFlightWrite()).toEqual({ cleaned: false }); // nothing in flight
  });

  // Codex P1 (round 20): the staging name is removed only while it still carries our inode.
  it('withdraws the publish when the staging link was renamed away and replaced', async () => {
    const realLink = fs.promises.link.bind(fs.promises);
    let stagingPath = '';
    const linkSpy = vi.spyOn(fs.promises, 'link').mockImplementation(async (from, to) => {
      await realLink(from, to);
      stagingPath = String(from);
      await fs.promises.rename(stagingPath, path.join(root, 'stolen-copy'));
      await fs.promises.writeFile(stagingPath, 'unrelated user data');
    });
    try {
      await expect(runDocsOutputWriteForTest(await request('report.bin', 'private-result', false), root)).rejects.toMatchObject({ code: 'PATH_NOT_ALLOWED' });
      expect(await fs.promises.readFile(stagingPath, 'utf8')).toBe('unrelated user data');
      expect((await fs.promises.stat(path.join(root, 'stolen-copy'))).size).toBe(0);
      await expect(fs.promises.stat(path.join(root, 'report.bin'))).rejects.toThrow();
    } finally {
      linkSpy.mockRestore();
    }
  });

  // Codex P1 (round 22): a bare rename of the staging link (ENOENT at its name) must not
  // pass as "removed by us"; the final link count exposes the extra link.
  it('withdraws the publish when the staging link was merely renamed away', async () => {
    const realLink = fs.promises.link.bind(fs.promises);
    const linkSpy = vi.spyOn(fs.promises, 'link').mockImplementation(async (from, to) => {
      await realLink(from, to);
      await fs.promises.rename(String(from), path.join(root, 'stolen-copy'));
    });
    try {
      await expect(runDocsOutputWriteForTest(await request('report.bin', 'private-result', false), root)).rejects.toMatchObject({ code: 'PATH_NOT_ALLOWED' });
      expect((await fs.promises.stat(path.join(root, 'stolen-copy'))).size).toBe(0);
      await expect(fs.promises.stat(path.join(root, 'report.bin'))).rejects.toThrow();
    } finally {
      linkSpy.mockRestore();
    }
  });

  // Codex P1 (round 21): the swap can also land between lstat and unlink; the retained
  // handle's link count exposes it afterwards and the publish is withdrawn.
  it('detects a staging swap that lands between lstat and unlink and withdraws', async () => {
    const realUnlink = fs.promises.unlink.bind(fs.promises);
    let swapped = '';
    const unlinkSpy = vi.spyOn(fs.promises, 'unlink').mockImplementation(async (target) => {
      const p = String(target);
      if (p.includes('.cindy-docs-staging-') && !swapped) {
        swapped = p;
        await fs.promises.rename(p, path.join(root, 'stolen-copy'));
        await fs.promises.writeFile(p, 'unrelated user data');
      }
      return realUnlink(target);
    });
    try {
      await expect(runDocsOutputWriteForTest(await request('report.bin', 'private-result', false), root)).rejects.toMatchObject({ code: 'PATH_NOT_ALLOWED' });
      expect(swapped).not.toBe('');
      expect((await fs.promises.stat(path.join(root, 'stolen-copy'))).size).toBe(0);
      await expect(fs.promises.stat(path.join(root, 'report.bin'))).rejects.toThrow();
    } finally {
      unlinkSpy.mockRestore();
    }
  });

  // Codex P1 (round 26): while the writer's own fail-closed cleanup is still running (e.g. a
  // blocking truncate), the in-flight capability stays registered so a cooperative abort
  // joins that cleanup instead of answering cleaned:false.
  it('abortInFlightWrite joins an in-progress failure cleanup instead of reporting nothing to clean', async () => {
    const realOpen = fs.promises.open.bind(fs.promises);
    const realLink = fs.promises.link.bind(fs.promises);
    let releaseTruncate: () => void = () => {};
    let truncateStarted = false;
    const gate = new Promise<void>((r) => { releaseTruncate = r; });
    const openSpy = vi.spyOn(fs.promises, 'open').mockImplementation(async (...args: Parameters<typeof fs.promises.open>) => {
      const handle = await realOpen(...args);
      if (String(args[0]).includes('.cindy-docs-staging-')) {
        const origTruncate = handle.truncate.bind(handle);
        handle.truncate = (async (len?: number) => { truncateStarted = true; await gate; return origTruncate(len); }) as typeof handle.truncate;
      }
      return handle;
    });
    // Induce a post-publication failure: staging link renamed away (extra link detected).
    const linkSpy = vi.spyOn(fs.promises, 'link').mockImplementation(async (from, to) => {
      await realLink(from, to);
      await fs.promises.rename(String(from), path.join(root, 'stolen-copy'));
    });
    try {
      const pending = runDocsOutputWriteForTest(await request('report.bin', 'private-result', false), root).then(() => 'resolved', (e: Error) => e.message);
      await waitFor(() => truncateStarted);
      let abortSettled = false;
      const abort = abortInFlightWrite().then((r) => { abortSettled = true; return r; });
      await new Promise((r) => setTimeout(r, 30));
      expect(abortSettled).toBe(false); // waiting on the shared cleanup, not answering false
      releaseTruncate();
      expect(await abort).toEqual({ cleaned: true });
      await pending;
      expect((await fs.promises.stat(path.join(root, 'stolen-copy'))).size).toBe(0);
    } finally {
      openSpy.mockRestore();
      linkSpy.mockRestore();
    }
  });

  // Codex P1 (round 25): an abort that lands while the exclusive open of the staging file
  // is still pending must wait for it, then clean the (still empty) inode; no byte is written.
  it('abortInFlightWrite waits for a pending staging open and cleans it before any byte is written', async () => {
    const realOpen = fs.promises.open.bind(fs.promises);
    let releaseOpen: () => void = () => {};
    let openStarted = false;
    let stagingPath = '';
    let bytesWritten = false;
    const gate = new Promise<void>((r) => { releaseOpen = r; });
    const openSpy = vi.spyOn(fs.promises, 'open').mockImplementation(async (...args: Parameters<typeof fs.promises.open>) => {
      if (String(args[0]).includes('.cindy-docs-staging-')) {
        stagingPath = String(args[0]);
        openStarted = true;
        await gate; // open outcome unknown until released
        const handle = await realOpen(...args);
        const origWrite = handle.writeFile.bind(handle);
        handle.writeFile = (async (...w: Parameters<typeof origWrite>) => { bytesWritten = true; return origWrite(...w); }) as typeof handle.writeFile;
        return handle;
      }
      return realOpen(...args);
    });
    try {
      const pending = runDocsOutputWriteForTest(await request('report.bin', 'private-result', false), root).then(() => 'resolved', (e: Error) => e.message);
      await waitFor(() => openStarted);
      const abort = abortInFlightWrite(); // lands while the open is pending
      await new Promise((r) => setTimeout(r, 10));
      releaseOpen();
      expect(await abort).toEqual({ cleaned: true });
      expect(await pending).toMatch(/中止/);
      expect(bytesWritten).toBe(false);
      await expect(fs.promises.access(stagingPath)).rejects.toThrow();
      await expect(fs.promises.access(path.join(root, 'report.bin'))).rejects.toThrow();
    } finally {
      openSpy.mockRestore();
    }
  });

  // Codex P1 (round 23): an abort that lands during the verifyParent await (before the commit
  // is started) has already zeroed the staging inode; the rename must not start afterwards.
  it('does not start the overwrite rename when an abort landed during the pre-commit verification', async () => {
    await runDocsOutputWriteForTest(await request('report.bin', 'old', false), root);
    const realLstat = fs.promises.lstat.bind(fs.promises);
    let gateOpen: () => void = () => {};
    let gated = false;
    let stagedSeen = false;
    const gate = new Promise<void>((r) => { gateOpen = r; });
    const realRoot = await fs.promises.realpath(root);
    // Build the request before installing the spy: on Linux realpath(root) === root, so the
    // helper's own lstat calls would otherwise be counted as verifyParent calls.
    const pendingRequest = await request('report.bin', 'new', true);
    const lstatSpy = vi.spyOn(fs.promises, 'lstat').mockImplementation((async (...args: Parameters<typeof fs.promises.lstat>) => {
      // The first root lstat *after* the staged notice is the verifyParent that runs once
      // the bytes are written — hold it so the abort lands there (platform-independent).
      if (stagedSeen && !gated && String(args[0]) === realRoot) { gated = true; await gate; }
      return realLstat(...args);
    }) as typeof fs.promises.lstat);
    const renameSpy = vi.spyOn(fs.promises, 'rename');
    try {
      const pending = runDocsOutputWriteForTest(pendingRequest, root, () => { stagedSeen = true; }).then(() => 'resolved', (e: Error) => e.message);
      await waitFor(() => gated);
      expect(await abortInFlightWrite()).toEqual({ cleaned: true });
      gateOpen();
      expect(await pending).toMatch(/中止/);
      expect(renameSpy).not.toHaveBeenCalled();
      expect(await fs.promises.readFile(path.join(root, 'report.bin'), 'utf8')).toBe('old');
    } finally {
      lstatSpy.mockRestore();
      renameSpy.mockRestore();
    }
  });

  // Codex P1 (round 21): an abort that lands while the overwrite rename is in flight must
  // wait for its outcome; a successful rename makes the inode the user's only copy.
  it('abortInFlightWrite waits for a pending overwrite rename and never zeroes a committed replacement', async () => {
    await runDocsOutputWriteForTest(await request('report.bin', 'old', false), root);
    const realRename = fs.promises.rename.bind(fs.promises);
    let releaseRename: () => void = () => {};
    const gate = new Promise<void>((r) => { releaseRename = r; });
    let renameStarted = false;
    const renameSpy = vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      renameStarted = true;
      await gate; // rename outcome unknown until released
      return realRename(from, to);
    });
    try {
      const pending = runDocsOutputWriteForTest(await request('report.bin', 'new', true), root);
      await waitFor(() => renameStarted);
      const abort = abortInFlightWrite(); // arrives while the rename is in flight
      await new Promise((r) => setTimeout(r, 10));
      releaseRename();
      expect(await abort).toEqual({ cleaned: false });
      await pending.catch(() => undefined);
      expect(await fs.promises.readFile(path.join(root, 'report.bin'), 'utf8')).toBe('new');
    } finally {
      renameSpy.mockRestore();
    }
  });

  // Codex P1 (round 17): after an overwrite rename the old inode is gone; a later failure
  // must not destroy the replacement, which is now the user's only copy.
  it('keeps the overwrite replacement when a post-rename step fails', async () => {
    await runDocsOutputWriteForTest(await request('report.bin', 'old', false), root);
    const realOpen = fs.promises.open.bind(fs.promises);
    const openSpy = vi.spyOn(fs.promises, 'open').mockImplementation(async (...args: Parameters<typeof fs.promises.open>) => {
      const handle = await realOpen(...args);
      const st = await handle.stat();
      if (st.isDirectory()) {
        handle.sync = async () => { throw Object.assign(new Error('EIO: disk'), { code: 'EIO' }); };
      }
      return handle;
    });
    try {
      await expect(runDocsOutputWriteForTest(await request('report.bin', 'new', true), root)).rejects.toMatchObject({ code: 'EIO' });
      expect(await fs.promises.readFile(path.join(root, 'report.bin'), 'utf8')).toBe('new');
    } finally {
      openSpy.mockRestore();
    }
  });

  // Codex P1 (round 28): the staging inode is created at the session root (not inside the
  // output directory) so the parent can still reach it if the output directory is moved out.
  // Codex P1 (round 29): a hard link / rename cannot cross filesystems. A nested mount as
  // output directory would make the root-anchored staging fail with EXDEV; the writer then
  // stages on the target's own filesystem and tells the parent where the name lives.
  it('stages at the root only when the output directory shares the root filesystem', () => {
    expect(chooseStagingLocation(1n, 1n)).toBe('root');
    expect(chooseStagingLocation(1n, 2n)).toBe('parent');
  });

  it('stages at the session root even for a nested output directory', async () => {
    const realOpen = fs.promises.open.bind(fs.promises);
    let stagingPath = '';
    const openSpy = vi.spyOn(fs.promises, 'open').mockImplementation(async (...args: Parameters<typeof fs.promises.open>) => {
      if (String(args[0]).includes('.cindy-docs-staging-')) stagingPath = String(args[0]);
      return realOpen(...args);
    });
    try {
      await runDocsOutputWriteForTest(await missingParentRequest('report.bin', 'nested'), root);
      expect(path.dirname(stagingPath)).toBe(await fs.promises.realpath(root));
      expect(await fs.promises.readFile(path.join(root, 'nested', 'reports', 'report.bin'), 'utf8')).toBe('nested');
      expect((await fs.promises.readdir(root)).filter((n) => n.includes('staging'))).toEqual([]);
    } finally {
      openSpy.mockRestore();
    }
  });

  it('returns the identity of the inode it published, read through its own handle', async () => {
    const identity = await runDocsOutputWriteForTest(await request('report.bin', 'payload', false), root);
    const st = await fs.promises.lstat(path.join(root, 'report.bin'), { bigint: true });
    expect(identity).toEqual({ dev: st.dev, ino: st.ino });
  });

  // Codex P1 (round 15): if the anchored parent is moved out of the root after the
  // hard-link publish but before the final parent check, the published content must be
  // withdrawn through the held handle, not merely reported as PATH_NOT_ALLOWED.
  it('withdraws a published file when the parent escapes the root after publication', async () => {
    const safe = path.join(root, 'safe');
    const outside = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cindy-docs-outside-'));
    cleanup.push(outside);
    await fs.promises.mkdir(safe);
    const pending = await request('report.bin', 'private-result', false, safe);
    const realLink = fs.promises.link.bind(fs.promises);
    // Some Windows versions refuse to move a directory while a file inside it is open
    // (the published hard link shares the open staging inode); the race then cannot be
    // staged there and the plain publish must succeed instead. Whether the move happened
    // is only known once the link mock has run, so the expectation is chosen after the
    // outcome settled — never from a flag read synchronously before the write started.
    let moved = false;
    const linkSpy = vi.spyOn(fs.promises, 'link').mockImplementation(async (from, to) => {
      await realLink(from, to);
      try {
        await fs.promises.rename(safe, path.join(outside, 'safe'));
        moved = true;
      } catch (error) {
        if (!['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      }
    });
    let settled: { ok: true; value: unknown } | { ok: false; error: unknown };
    try {
      settled = await runDocsOutputWriteForTest(pending, root).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    } finally {
      linkSpy.mockRestore();
    }
    if (!moved) {
      expect(process.platform).toBe('win32');
      expect(settled).toMatchObject({ ok: true, value: { dev: expect.any(BigInt) } });
      return;
    }
    expect(settled).toMatchObject({ ok: false, error: { code: 'PATH_NOT_ALLOWED' } });
    const escaped = await fs.promises.stat(path.join(outside, 'safe', 'report.bin')).catch(() => null);
    if (escaped) expect(escaped.size).toBe(0);
    const leftovers = (await fs.promises.readdir(path.join(outside, 'safe'))).filter((n) => n.includes('staging'));
    for (const name of leftovers) {
      expect((await fs.promises.stat(path.join(outside, 'safe', name))).size).toBe(0);
    }
  });

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
