import { mkdir, mkdtemp, readFile as fsReadFile, rm, symlink, writeFile as fsWriteFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createFile,
  createFolder,
  deleteEntry,
  readFile,
  renameEntry,
  statEntry,
  writeFile,
} from '../scanner';

async function makeSymlinkFixture(): Promise<
  | { kind: 'ready'; root: string; workdir: string; relPath: string }
  | { kind: 'skip'; root: string }
> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'xdt-file-browser-'));
  const workdir = path.join(root, 'workdir');
  const outside = path.join(root, 'outside.txt');
  const link = path.join(workdir, 'linked-outside.txt');
  await fsWriteFile(outside, 'secret outside workdir', 'utf8');
  await mkdir(workdir);
  try {
    await symlink(outside, link, 'file');
  } catch {
    return { kind: 'skip', root };
  }
  return { kind: 'ready', root, workdir, relPath: 'linked-outside.txt' };
}

describe('file-browser scanner symlink boundaries', () => {
  it('rejects read/stat/write through a symlink that escapes the workdir', async () => {
    const fixture = await makeSymlinkFixture();
    try {
      if (fixture.kind === 'skip') return;

      await expect(readFile(fixture.workdir, fixture.relPath)).rejects.toThrow(
        /escapes workdir via symlink/,
      );
      await expect(statEntry(fixture.workdir, fixture.relPath)).rejects.toThrow(
        /escapes workdir via symlink/,
      );
      await expect(writeFile(fixture.workdir, fixture.relPath, 'overwrite')).rejects.toThrow(
        /escapes workdir via symlink/,
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('rejects create operations when the parent directory is an escaping symlink', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xdt-file-browser-'));
    const workdir = path.join(root, 'workdir');
    const outside = path.join(root, 'outside-dir');
    const link = path.join(workdir, 'linked-outside');
    await mkdir(workdir);
    await mkdir(outside);
    try {
      try {
        await symlink(outside, link, 'dir');
      } catch {
        return;
      }

      await expect(createFile(workdir, 'linked-outside/new.txt')).rejects.toThrow(
        /escapes workdir via symlink/,
      );
      await expect(createFolder(workdir, 'linked-outside/new-dir')).rejects.toThrow(
        /escapes workdir via symlink/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects rename and delete through a symlink that escapes the workdir', async () => {
    const fixture = await makeSymlinkFixture();
    try {
      if (fixture.kind === 'skip') return;

      await fsWriteFile(path.join(fixture.workdir, 'inside.txt'), 'inside', 'utf8');
      await expect(renameEntry(fixture.workdir, fixture.relPath, 'renamed.txt')).rejects.toThrow(
        /escapes workdir via symlink/,
      );
      await expect(deleteEntry(fixture.workdir, fixture.relPath)).rejects.toThrow(
        /escapes workdir via symlink/,
      );
      await expect(fsReadFile(path.join(fixture.root, 'outside.txt'), 'utf8')).resolves.toBe(
        'secret outside workdir',
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});

describe('file-browser scanner path boundaries', () => {
  it('rejects absolute paths instead of silently resolving them workdir-relative', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xdt-file-browser-'));
    try {
      // assertInsideWorkdir's docstring promises a throw on absolute paths. A
      // leading slash must not be silently stripped and reinterpreted as
      // `${workdir}/etc/passwd` — that turns a caller bug into a wrong-file read.
      await expect(readFile(root, '/etc/passwd')).rejects.toThrow(/absolute path not allowed/);
      await expect(statEntry(root, '/etc/passwd')).rejects.toThrow(/absolute path not allowed/);
      // Backslashes are normalized to '/' first, so a Windows-style absolute
      // path hits the same guard rather than slipping through.
      await expect(statEntry(root, '\\Windows\\system32')).rejects.toThrow(
        /absolute path not allowed/,
      );
      // Windows drive paths are rejected via a host-independent check
      // (path.win32.isAbsolute + a drive-letter regex), so they never reach
      // path.resolve where a Windows host would mis-interpret them. This covers
      // both drive-*absolute* ('C:\\x' / 'C:/x') and drive-*relative* ('C:foo' /
      // 'C:') — the latter is Windows drive-relative syntax (resolved against
      // drive C:'s CWD), not a literal workdir entry, so it must not slip through.
      await expect(statEntry(root, 'C:\\Windows\\system32')).rejects.toThrow(
        /absolute path not allowed/,
      );
      await expect(readFile(root, 'C:/Windows/system32')).rejects.toThrow(
        /absolute path not allowed/,
      );
      await expect(statEntry(root, 'C:foo')).rejects.toThrow(/absolute path not allowed/);
      await expect(statEntry(root, 'C:')).rejects.toThrow(/absolute path not allowed/);
      await expect(readFile(root, 'c:bar')).rejects.toThrow(/absolute path not allowed/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects parent-traversal that escapes the workdir', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xdt-file-browser-'));
    try {
      await expect(readFile(root, '../outside.txt')).rejects.toThrow(/escapes workdir/);
      await expect(statEntry(root, '../../etc/passwd')).rejects.toThrow(/escapes workdir/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('still normalizes a leading "./" to a plain workdir-relative path', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xdt-file-browser-'));
    try {
      await fsWriteFile(path.join(root, 'note.txt'), 'hi', 'utf8');
      const stat = await statEntry(root, './note.txt');
      expect(stat.relPath).toBe('note.txt');
      expect(stat.type).toBe('file');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('readFileChunk', () => {
  it('reassembles a file losslessly across chunk boundaries (binary, no zero-padding)', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xdt-file-browser-'));
    try {
      // 刻意非整分片大小 + 含 0x00 的伪随机二进制:拼接结果必须逐字节相等,
      // 锁定"短读补零 / offset 推进过头"这类静默损坏(PR #503 review P1)。
      const size = 3 * 1024 + 137;
      const src = Buffer.alloc(size);
      for (let i = 0; i < size; i++) src[i] = (i * 31 + 7) % 256;
      await fsWriteFile(path.join(root, 'blob.bin'), src);

      const { readFileChunk } = await import('../scanner');
      const parts: Buffer[] = [];
      let offset = 0;
      for (;;) {
        const chunk = await readFileChunk(root, 'blob.bin', offset, 1024);
        parts.push(chunk.data);
        offset += chunk.data.length;
        expect(chunk.size).toBe(size);
        if (chunk.eof) break;
        expect(chunk.data.length).toBeGreaterThan(0);
      }
      expect(offset).toBe(size);
      expect(Buffer.concat(parts).equals(src)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('clamps reads past EOF to empty data with eof=true', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xdt-file-browser-'));
    try {
      await fsWriteFile(path.join(root, 'small.txt'), 'hello', 'utf8');
      const { readFileChunk } = await import('../scanner');
      const chunk = await readFileChunk(root, 'small.txt', 100, 1024);
      expect(chunk.data.length).toBe(0);
      expect(chunk.eof).toBe(true);
      expect(chunk.size).toBe(5);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
