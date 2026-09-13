import { link as fsLink, mkdir, mkdtemp, readFile as fsReadFile, rm, stat as fsStat, symlink, writeFile as fsWriteFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { promises as fsp } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import {
  createFile,
  createFolder,
  deleteEntry,
  readFile,
  renameEntry,
  statEntry,
  writeFile,
  writeNewFile,
  verifyNewFile,
  eraseIfSame,
  releaseNewFile,
  NewFileHoldRegistry,
  chooseStagingDir,
  identityOf,
  sameIdentity,
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

/** 最小合法 PDF:一页、无压缩对象流、整份文件不含 NUL 字节。 */
const MINIMAL_NUL_FREE_PDF = [
  '%PDF-1.4',
  '1 0 obj',
  '<< /Type /Catalog /Pages 2 0 R >>',
  'endobj',
  '2 0 obj',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  'endobj',
  '3 0 obj',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] >>',
  'endobj',
  'trailer',
  '<< /Root 1 0 R >>',
  '%%EOF',
  '',
].join('\n');

async function expectBinaryFileError(promise: Promise<unknown>): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code: 'BINARY_FILE' });
}

describe('readFile binary detection', () => {
  it('treats a NUL-free PDF as binary so the renderer can route it to PdfPreview', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xdt-file-browser-'));
    try {
      expect(MINIMAL_NUL_FREE_PDF.includes('\0')).toBe(false);
      await fsWriteFile(path.join(root, 'doc.pdf'), MINIMAL_NUL_FREE_PDF, 'latin1');
      await expectBinaryFileError(readFile(root, 'doc.pdf'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('classifies the issue #4158 repro PDF (no NUL in the first 4 KiB) as binary', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xdt-file-browser-'));
    try {
      const fixture = await fsReadFile(path.join(__dirname, 'fixtures', 'nul-free.pdf'));
      expect(fixture.subarray(0, 4096).includes(0)).toBe(false);
      await fsWriteFile(path.join(root, 'repro.pdf'), fixture);
      await expectBinaryFileError(readFile(root, 'repro.pdf'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('detects the PDF header when a few junk bytes precede it', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xdt-file-browser-'));
    try {
      await fsWriteFile(path.join(root, 'junk.pdf'), `ï»¿\n${MINIMAL_NUL_FREE_PDF}`, 'latin1');
      await expectBinaryFileError(readFile(root, 'junk.pdf'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps a non-.pdf text file that quotes %PDF- in its first line as text', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xdt-file-browser-'));
    try {
      const notes = `# PDF header\nEvery PDF starts with %PDF-1.x followed by objects.\n`;
      await fsWriteFile(path.join(root, 'notes.md'), notes, 'utf8');
      const result = await readFile(root, 'notes.md');
      expect(result.content).toBe(notes);
      await writeFile(root, 'notes.md', `${notes}edited\n`);
      expect(await fsReadFile(path.join(root, 'notes.md'), 'utf8')).toBe(`${notes}edited\n`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('matches the .pdf extension case-insensitively', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xdt-file-browser-'));
    try {
      await fsWriteFile(path.join(root, 'SCAN.PDF'), MINIMAL_NUL_FREE_PDF, 'latin1');
      await expectBinaryFileError(readFile(root, 'SCAN.PDF'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('still returns a .pdf-named text file when the header lies past the 1 KiB window', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xdt-file-browser-'));
    try {
      const notes = `${'# PDF notes\n'.repeat(120)}The header is %PDF-1.7 followed by objects.\n`;
      expect(notes.indexOf('%PDF-')).toBeGreaterThan(1024);
      await fsWriteFile(path.join(root, 'notes.pdf'), notes, 'utf8');
      const result = await readFile(root, 'notes.pdf');
      expect(result.content).toBe(notes);
      expect(result.truncated).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses to overwrite a NUL-free PDF through the text editor path', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xdt-file-browser-'));
    try {
      await fsWriteFile(path.join(root, 'doc.pdf'), MINIMAL_NUL_FREE_PDF, 'latin1');
      await expect(writeFile(root, 'doc.pdf', 'not a pdf anymore')).rejects.toThrow(/binary file/);
      expect(await fsReadFile(path.join(root, 'doc.pdf'), 'latin1')).toBe(MINIMAL_NUL_FREE_PDF);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('writeNewFile', () => {
  it('fails closed when the parent is swapped for an outside symlink between the check and the open', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xdt-write-new-swap-'));
    const workdir = path.join(root, 'workdir');
    const outside = path.join(root, 'outside');
    await mkdir(path.join(workdir, 'tool-results'), { recursive: true });
    await mkdir(outside);
    const realOpen = fsp.open.bind(fsp);
    let swapped = false;
    const spy = vi.spyOn(fsp, 'open').mockImplementation(async (...args: Parameters<typeof fsp.open>) => {
      if (!swapped) {
        swapped = true;
        // Race window: the parent dir was validated, now replace it with a link that escapes.
        await rm(path.join(workdir, 'tool-results'), { recursive: true });
        try {
          await symlink(outside, path.join(workdir, 'tool-results'), 'dir');
        } catch {
          return realOpen(...args);
        }
      }
      return realOpen(...args);
    });
    try {
      let failure: unknown = null;
      try {
        await writeNewFile(workdir, 'tool-results/secret.json', '{"secret":true}');
      } catch (err) {
        failure = err;
      }
      if (!swapped) return; // platform without symlink support
      expect(String(failure)).toMatch(/escapes workdir via symlink/);
      // Nothing with content may remain outside (names are left alone, content is zeroed).
      expect((await fsp.stat(path.join(outside, 'secret.json')).catch(() => null))?.size ?? 0).toBe(0);
    } finally {
      spy.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('creates the file with a private 0600 mode regardless of umask', async () => {
    if (process.platform === 'win32') return;
    const root = await mkdtemp(path.join(os.tmpdir(), 'xdt-write-new-mode-'));
    try {
      // umask can only clear bits: with an explicit 0o600 the result is never wider,
      // whatever the process umask is (workers cannot change it).
      await writeNewFile(root, 'private.json', '{"secret":true}');
      const st = await fsp.lstat(path.join(root, 'private.json'));
      expect(st.mode & 0o777).toBe(0o600);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('zeroes the content and fails when the parent is moved out during the write', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xdt-write-new-move-'));
    const workdir = path.join(root, 'workdir');
    const outside = path.join(root, 'outside');
    await mkdir(path.join(workdir, 'tool-results'), { recursive: true });
    const realOpen = fsp.open.bind(fsp);
    let moved = false;
    const spy = vi.spyOn(fsp, 'open').mockImplementation(async (...args: Parameters<typeof fsp.open>) => {
      const handle = await realOpen(...args);
      const realWrite = handle.writeFile.bind(handle);
      return Object.assign(Object.create(handle), {
        writeFile: async (...w: Parameters<typeof handle.writeFile>) => {
          await realWrite(...w);
          // Race window: the write landed, now the directory is moved outside the workdir.
          await fsp.rename(path.join(workdir, 'tool-results'), outside);
          moved = true;
        },
        stat: ((...st: Parameters<typeof handle.stat>) => handle.stat(...st)) as typeof handle.stat,
        truncate: (len?: number) => handle.truncate(len),
        close: () => handle.close(),
      }) as typeof handle;
    });
    try {
      // With root staging the bytes never travel through `tool-results`: moving it away
      // during the write only makes the publish fail, and nothing with content leaks.
      await expect(writeNewFile(workdir, 'tool-results/secret.json', '{"secret":true}')).rejects.toThrow();
      expect(moved).toBe(true);
      const leaked = await fsp.stat(path.join(outside, 'secret.json')).catch(() => null);
      expect(leaked?.size ?? 0).toBe(0);
      for (const name of (await fsp.readdir(workdir)).filter(n => n.endsWith('.staging'))) {
        expect((await fsp.stat(path.join(workdir, name))).size).toBe(0);
      }
    } finally {
      spy.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('unlinks and zeroes a published entry when the parent is swapped right at publish time', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xdt-write-new-publish-'));
    const workdir = path.join(root, 'workdir');
    const outside = path.join(root, 'outside');
    await mkdir(path.join(workdir, 'tool-results'), { recursive: true });
    await mkdir(outside);
    const realLink = fsp.link.bind(fsp);
    let swapped = false;
    const spy = vi.spyOn(fsp, 'link').mockImplementation(async (from, to) => {
      // Race window between the parent re-check and the link syscall.
      await rm(path.join(workdir, 'tool-results'), { recursive: true });
      try {
        await symlink(outside, path.join(workdir, 'tool-results'), 'dir');
        swapped = true;
      } catch {
        await mkdir(path.join(workdir, 'tool-results'));
      }
      return realLink(from, to);
    });
    try {
      let failure: unknown = null;
      try {
        await writeNewFile(workdir, 'tool-results/secret.json', '{"secret":true}');
      } catch (err) {
        failure = err;
      }
      if (!swapped) return;
      expect(String(failure)).toMatch(/escapes workdir via symlink/);
      expect((await fsp.stat(path.join(outside, 'secret.json')).catch(() => null))?.size ?? 0).toBe(0);
      for (const name of (await fsp.readdir(workdir)).filter(n => n.endsWith('.staging'))) {
        expect((await fsp.stat(path.join(workdir, name))).size).toBe(0);
      }
    } finally {
      spy.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('syncs the staged bytes before publishing and returns the inode identity', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xdt-write-new-sync-'));
    const realOpen = fsp.open.bind(fsp);
    const order: string[] = [];
    const linkSpy = vi.spyOn(fsp, 'link').mockImplementation(async (from, to) => { order.push('link'); return fsp.link.getMockImplementation ? (await (Object.getPrototypeOf(fsp).link ?? fsp.link)) && undefined : undefined; });
    linkSpy.mockRestore();
    const realLink = fsp.link.bind(fsp);
    const linkSpy2 = vi.spyOn(fsp, 'link').mockImplementation(async (from, to) => { order.push('link'); return realLink(from, to); });
    const openSpy = vi.spyOn(fsp, 'open').mockImplementation(async (...args: Parameters<typeof fsp.open>) => {
      const handle = await realOpen(...args);
      const realSync = handle.sync.bind(handle);
      return Object.assign(Object.create(handle), {
        sync: async () => { order.push('sync'); return realSync(); },
        writeFile: (...w: Parameters<typeof handle.writeFile>) => handle.writeFile(...w),
        stat: ((...st: Parameters<typeof handle.stat>) => handle.stat(...st)) as typeof handle.stat,
        truncate: (len?: number) => handle.truncate(len),
        close: () => handle.close(),
      }) as typeof handle;
    });
    try {
      const result = await writeNewFile(root, 'out.json', '{"ok":true}');
      // bytes fsync → link → parent-directory fsync (round 11) → root fsync after staging unlink (round 12)
      expect(order).toEqual(['sync', 'link', 'sync', 'sync']);
      const st = await fsp.lstat(path.join(root, 'out.json'), { bigint: true }); // 64-bit file ids: never compare through a lossy number
      expect(result).toMatchObject({ size: 11, dev: st.dev.toString(), ino: st.ino.toString() });
    } finally {
      openSpy.mockRestore();
      linkSpy2.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('removes the exclusively created file when the write itself fails', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xdt-write-new-fail-'));
    const realOpen = fsp.open.bind(fsp);
    const spy = vi.spyOn(fsp, 'open').mockImplementation(async (...args: Parameters<typeof fsp.open>) => {
      const handle = await realOpen(...args);
      return Object.assign(Object.create(handle), {
        writeFile: async () => { throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }); },
        close: () => handle.close(),
      }) as typeof handle;
    });
    try {
      await expect(writeNewFile(root, 'partial.json', '{"x":1}')).rejects.toThrow(/ENOSPC/);
      await expect(fsReadFile(path.join(root, 'partial.json'))).rejects.toThrow(/ENOENT/); // never published
      for (const name of (await fsp.readdir(root)).filter(n => n.endsWith('.staging'))) {
        expect((await fsp.stat(path.join(root, name))).size).toBe(0);
      }
    } finally {
      spy.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('creates and writes a new file exclusively in one step', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xdt-file-browser-new-'));
    try {
      await mkdir(path.join(root, 'tool-results'));
      const result = await writeNewFile(root, 'tool-results/a.json', '{"ok":true,"文":"字"}');
      expect(result.size).toBe(Buffer.byteLength('{"ok":true,"文":"字"}', 'utf8'));
      expect(await fsReadFile(path.join(root, 'tool-results/a.json'), 'utf8')).toBe('{"ok":true,"文":"字"}');
      // Second attempt at the same path must fail instead of overwriting.
      await expect(writeNewFile(root, 'tool-results/a.json', 'again')).rejects.toThrow(/EEXIST/);
      expect(await fsReadFile(path.join(root, 'tool-results/a.json'), 'utf8')).toBe('{"ok":true,"文":"字"}');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses a symlink planted at the target and never follows it', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xdt-file-browser-new-'));
    try {
      const victim = path.join(root, 'victim.txt');
      await fsWriteFile(victim, 'keep me', 'utf8');
      try {
        await symlink(victim, path.join(root, 'planted.json'), 'file');
      } catch {
        return;
      }
      await expect(writeNewFile(root, 'planted.json', 'overwrite')).rejects.toThrow(/EEXIST/);
      expect(await fsReadFile(victim, 'utf8')).toBe('keep me');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses a parent that escapes the workdir, a missing parent and oversized content', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xdt-file-browser-new-'));
    try {
      const workdir = path.join(root, 'workdir');
      const outside = path.join(root, 'outside');
      await mkdir(workdir);
      await mkdir(outside);
      try {
        await symlink(outside, path.join(workdir, 'linked-outside'), 'dir');
      } catch {
        return;
      }
      await expect(writeNewFile(workdir, 'linked-outside/new.json', 'x')).rejects.toThrow(/escapes workdir via symlink/);
      await expect(writeNewFile(workdir, 'missing/new.json', 'x')).rejects.toThrow();
      await expect(writeNewFile(workdir, '../new.json', 'x')).rejects.toThrow();
      await expect(writeNewFile(workdir, 'big.json', 'x'.repeat(2 * 1024 * 1024 + 1))).rejects.toThrow(/content too large/);
      await expect(writeNewFile(workdir, '', 'x')).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('verifyNewFile / eraseIfSame', () => {
  const sha = (text: string) => createHash('sha256').update(text).digest('hex');

  it('verifies only the exact regular file with matching size and content, and returns its identity', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xdt-verify-new-'));
    try {
      const written = await writeNewFile(root, 'r.json', '{"a":1}');
      const verified = await verifyNewFile(root, 'r.json', sha('{"a":1}'), 7);
      expect(verified).toMatchObject({ dev: written.dev, ino: written.ino, size: 7 });
      await expect(verifyNewFile(root, 'r.json', sha('{"a":2}'), 7)).rejects.toThrow(/content mismatch/);
      await expect(verifyNewFile(root, 'r.json', sha('{"a":1}'), 6)).rejects.toThrow(/size mismatch/);
      await expect(verifyNewFile(root, 'missing.json', sha('x'), 1)).rejects.toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('refuses a symlink even when its referent has the expected content', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xdt-verify-link-'));
    try {
      await fsWriteFile(path.join(root, 'real.json'), '{"a":1}');
      try { await symlink(path.join(root, 'real.json'), path.join(root, 'alias.json'), 'file'); } catch { return; }
      await expect(verifyNewFile(root, 'alias.json', sha('{"a":1}'), 7)).rejects.toThrow(/not a regular file/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('eraseIfSame zeroes only the matching inode, never follows a swapped symlink, and never unlinks', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xdt-erase-same-'));
    try {
      const written = await writeNewFile(root, 'spill.json', '{"a":1}');
      await fsWriteFile(path.join(root, 'other.json'), 'keep me');
      // Wrong identity: untouched.
      expect(await eraseIfSame(root, 'spill.json', written.dev, `${written.ino}0`)).toEqual({ erased: false });
      expect(await fsReadFile(path.join(root, 'spill.json'), 'utf8')).toBe('{"a":1}');
      // Swap the path for a symlink to unrelated data: not our inode, so nothing is touched.
      await rm(path.join(root, 'spill.json'));
      let linked = true;
      try { await symlink(path.join(root, 'other.json'), path.join(root, 'spill.json'), 'file'); } catch { linked = false; }
      if (linked) {
        expect(await eraseIfSame(root, 'spill.json', written.dev, written.ino)).toEqual({ erased: false });
        expect(await fsReadFile(path.join(root, 'other.json'), 'utf8')).toBe('keep me');
        await rm(path.join(root, 'spill.json'));
      }
      // Matching identity: content erased through the descriptor, pathname kept (no TOCTOU unlink).
      const again = await writeNewFile(root, 'spill.json', '{"b":2}');
      expect(await eraseIfSame(root, 'spill.json', again.dev, again.ino)).toEqual({ erased: true });
      expect((await fsStat(path.join(root, 'spill.json'))).size).toBe(0);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  // Codex P1 (round 11): publication is a directory-entry change, so the parent directory
  // is fsynced after `link` (and after `mkdir` in createFolder) before success is reported.
  it('writeNewFile and createFolder fsync the parent directory after publishing the entry', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xdt-dir-sync-'));
    const realRoot = await fsp.realpath(root);
    const events: string[] = [];
    const realOpen = fsp.open.bind(fsp);
    const spy = vi.spyOn(fsp, 'open').mockImplementation(async (...args: Parameters<typeof fsp.open>) => {
      const handle = await realOpen(...args);
      const st = await handle.stat();
      if (st.isDirectory()) {
        const dirPath = String(args[0]);
        const origSync = handle.sync.bind(handle);
        handle.sync = async () => { events.push(`sync:${dirPath}`); await origSync(); };
      }
      return handle;
    });
    try {
      await createFolder(root, 'out');
      events.push('mkdir-done');
      const written = await writeNewFile(root, 'out/spill.json', '{"a":1}');
      events.push('link-done');
      expect(written.size).toBe(7);
      // mkdir → root sync; link → parent sync; staging unlink at root → root sync (round 12)
      expect(events).toEqual([`sync:${realRoot}`, 'mkdir-done', `sync:${path.join(realRoot, 'out')}`, `sync:${realRoot}`, 'link-done']);
    } finally {
      spy.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  // Windows CI (head 3e38a6d7f): NTFS file IDs are 64-bit, so as JS numbers two different
  // inodes can compare equal (ino + 1 === ino above 2^53). Identity is bigint-backed and
  // carried as decimal strings; a difference in the lowest bit must still be a mismatch.
  it('identity comparison keeps the low bits of 64-bit file ids', () => {
    const high = 2n ** 60n;
    expect(Number(high + 1n)).toBe(Number(high)); // the precision loss that broke Windows
    expect(sameIdentity({ dev: 1n, ino: high + 1n }, '1', high.toString())).toBe(false);
    expect(sameIdentity({ dev: 1n, ino: high + 1n }, '1', (high + 1n).toString())).toBe(true);
    expect(identityOf({ dev: 1n, ino: high + 1n })).toEqual({ dev: '1', ino: (high + 1n).toString() });
  });

  // Codex P1 (round 16): a published file whose staging link still exists is not final —
  // the original writeNewFile may still withdraw it. Recovery must wait for completion.
  it('verifyNewFile refuses a matching file while its staging link is still present', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xdt-verify-inflight-'));
    try {
      await fsWriteFile(path.join(root, 'r.json'), '{"a":1}');
      await fsWriteFile(path.join(root, '.r.json.some-uuid.staging'), '{"a":1}');
      await expect(verifyNewFile(root, 'r.json', sha('{"a":1}'), 7)).rejects.toThrow(/still in flight/);
      await rm(path.join(root, '.r.json.some-uuid.staging'));
      await expect(verifyNewFile(root, 'r.json', sha('{"a":1}'), 7)).resolves.toMatchObject({ size: 7 });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  // Codex P1 (round 20): the staging name is unlinked only while it still carries our inode.
  it('writeNewFile withdraws the publish when the staging link was renamed away and replaced', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xdt-staging-replaced-'));
    const realRoot = await fsp.realpath(root);
    const realLink = fsp.link.bind(fsp);
    let stagingPath = '';
    const spy = vi.spyOn(fsp, 'link').mockImplementation(async (from, to) => {
      await realLink(from, to);
      stagingPath = String(from);
      // A workdir process moves the staging link away and puts an unrelated file at its name.
      await fsp.rename(stagingPath, path.join(realRoot, 'stolen-copy'));
      await fsWriteFile(stagingPath, 'unrelated user data');
    });
    try {
      await mkdir(path.join(root, 'out'));
      await expect(writeNewFile(root, 'out/spill.json', '{"secret":1}')).rejects.toThrow(/replaced or moved/);
      expect(await fsReadFile(stagingPath, 'utf8')).toBe('unrelated user data');
      expect((await fsStat(path.join(realRoot, 'stolen-copy'))).size).toBe(0);
      expect((await fsStat(path.join(root, 'out', 'spill.json')).catch(() => null))?.size ?? 0).toBe(0); // withdrawn: erased, name may remain
    } finally {
      spy.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  // Codex P1 (round 22): a bare rename of the staging link (no replacement at its name)
  // leaves an extra hard link with the private bytes; the final link count catches it.
  it('writeNewFile withdraws the publish when the staging link was merely renamed away', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xdt-staging-renamed-'));
    const realRoot = await fsp.realpath(root);
    const realLink = fsp.link.bind(fsp);
    const spy = vi.spyOn(fsp, 'link').mockImplementation(async (from, to) => {
      await realLink(from, to);
      await fsp.rename(String(from), path.join(realRoot, 'stolen-copy'));
    });
    try {
      await mkdir(path.join(root, 'out'));
      await expect(writeNewFile(root, 'out/spill.json', '{"secret":1}')).rejects.toThrow(/replaced or moved/);
      expect((await fsStat(path.join(realRoot, 'stolen-copy'))).size).toBe(0);
      // Withdrawn: content erased through the handle; the pathname is deliberately left
      // alone (no check-then-unlink on a mutable path), so it still exists and is empty.
      expect((await fsStat(path.join(root, 'out', 'spill.json'))).size).toBe(0);
    } finally {
      spy.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  // Codex P1 (round 21): a swap landing between lstat and unlink is caught by the link count.
  it('writeNewFile detects a staging swap between lstat and unlink and withdraws', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xdt-staging-swap-'));
    const realRoot = await fsp.realpath(root);
    const realUnlink = fsp.unlink.bind(fsp);
    let swapped = '';
    const spy = vi.spyOn(fsp, 'unlink').mockImplementation(async (target) => {
      const p = String(target);
      if (p.includes('.staging') && !swapped) {
        swapped = p;
        await fsp.rename(p, path.join(realRoot, 'stolen-copy'));
        await fsWriteFile(p, 'unrelated user data');
      }
      return realUnlink(target);
    });
    try {
      await mkdir(path.join(root, 'out'));
      await expect(writeNewFile(root, 'out/spill.json', '{"secret":1}')).rejects.toThrow(/replaced or moved/);
      expect(swapped).not.toBe('');
      expect((await fsStat(path.join(realRoot, 'stolen-copy'))).size).toBe(0);
      expect((await fsStat(path.join(root, 'out', 'spill.json')).catch(() => null))?.size ?? 0).toBe(0); // withdrawn: erased, name may remain
    } finally {
      spy.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  // Codex P1 (round 17): an unreadable marker directory is not "no marker".
  it('verifyNewFile fails closed when the completion-marker scan cannot be performed', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xdt-verify-scanfail-'));
    const realRoot = await fsp.realpath(root);
    const realReaddir = fsp.readdir.bind(fsp);
    const spy = vi.spyOn(fsp, 'readdir').mockImplementation((async (...args: Parameters<typeof fsp.readdir>) => {
      if (String(args[0]) === realRoot) throw Object.assign(new Error('EIO'), { code: 'EIO' });
      return realReaddir(...args);
    }) as typeof fsp.readdir);
    try {
      await fsWriteFile(path.join(root, 'r.json'), '{"a":1}');
      await expect(verifyNewFile(root, 'r.json', sha('{"a":1}'), 7)).rejects.toThrow(/cannot scan completion marker/);
    } finally {
      spy.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  // Codex P1 (round 27): marker absence can be manufactured (staging link renamed away while
  // the write is in flight); the verified inode itself must have exactly one link.
  it('verifyNewFile refuses an inode that still has a second link even without a staging marker', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xdt-verify-nlink-'));
    try {
      await fsWriteFile(path.join(root, 'r.json'), '{"a":1}');
      await fsLink(path.join(root, 'r.json'), path.join(root, 'renamed-staging-copy'));
      await expect(verifyNewFile(root, 'r.json', sha('{"a":1}'), 7)).rejects.toThrow(/still in flight/);
      await rm(path.join(root, 'renamed-staging-copy'));
      await expect(verifyNewFile(root, 'r.json', sha('{"a":1}'), 7)).resolves.toMatchObject({ size: 7 });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('writeNewFile keeps the publish but reports durable:false when the root fsync after staging removal fails', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xdt-root-sync-fail-'));
    const realRoot = await fsp.realpath(root);
    const realOpen = fsp.open.bind(fsp);
    let rootSyncs = 0;
    const spy = vi.spyOn(fsp, 'open').mockImplementation(async (...args: Parameters<typeof fsp.open>) => {
      const handle = await realOpen(...args);
      const st = await handle.stat();
      if (st.isDirectory() && String(args[0]) === realRoot) {
        handle.sync = async () => { rootSyncs += 1; throw Object.assign(new Error('EIO'), { code: 'EIO' }); };
      }
      return handle;
    });
    try {
      await mkdir(path.join(root, 'out'));
      const written = await writeNewFile(root, 'out/spill.json', '{"a":1}');
      expect(written.size).toBe(7);
      expect(rootSyncs).toBe(2); // one attempt + one retry, publish kept
      expect(await fsReadFile(path.join(root, 'out', 'spill.json'), 'utf8')).toBe('{"a":1}');
      expect((await fsp.readdir(root)).filter(n => n.includes('.staging'))).toEqual([]);
      // Round 30: the persistent sync failure is reported, not swallowed — the caller decides.
      expect(written.durable).toBe(false);
    } finally {
      spy.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  // Codex P1 (round 12): the staging hard link is a full private copy; its removal is
  // required for success, and a failure zeroes the content and withdraws the publish.
  it('writeNewFile fails closed when the staging hard link cannot be removed', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xdt-staging-unlink-'));
    const realUnlink = fsp.unlink.bind(fsp);
    let stagingPath = '';
    const spy = vi.spyOn(fsp, 'unlink').mockImplementation(async (target) => {
      const p = String(target);
      if (p.includes('.staging') && !stagingPath) {
        stagingPath = p;
        const err = Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' });
        throw err;
      }
      return realUnlink(target);
    });
    try {
      await expect(writeNewFile(root, 'spill.json', '{"secret":1}')).rejects.toThrow(/EBUSY/);
      expect(stagingPath).not.toBe('');
      expect((await fsStat(path.join(root, 'spill.json')).catch(() => null))?.size ?? 0).toBe(0);
      // Whatever remains of the staging entry holds no content.
      const leftover = await fsStat(stagingPath).catch(() => null);
      if (leftover) expect(leftover.size).toBe(0);
    } finally {
      spy.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  // Codex P1 (round 29/30): the caller's bookkeeping after writeNewFile (authorization
  // re-check, ledger) is an async window in which a workdir process can move the output
  // directory out of the workdir. The daemon keeps the writer's own descriptor as the
  // caller's inode capability: the withdrawal goes through it, never through a pathname.
  describe('daemon-held descriptor (round 30)', () => {
    it('writeNewFile retains a hold that eraseIfSame uses after the directory was moved out', async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'xdt-hold-moved-'));
      const outside = await mkdtemp(path.join(os.tmpdir(), 'xdt-hold-outside-'));
      const holds = new NewFileHoldRegistry();
      try {
        await mkdir(path.join(root, 'out'));
        const written = await writeNewFile(root, 'out/spill.json', '{"secret":1}', holds);
        expect(written.holdId).toMatch(/^[0-9a-f-]{36}$/);
        expect(written.durable).toBe(true);
        expect(holds.size).toBe(1);
        // No marker, no second link: the published name is the inode's only name.
        expect((await fsp.readdir(root)).filter(n => n.startsWith('.'))).toEqual([]);
        expect((await fsp.stat(path.join(root, 'out', 'spill.json'), { bigint: true })).nlink).toBe(1n);
        await fsp.rename(path.join(root, 'out'), path.join(outside, 'out'));
        // Without the hold the erase cannot reach the inode any more (vanished parent is not an escape) ...
        expect(await eraseIfSame(root, 'out/spill.json', written.dev, written.ino)).toEqual({ erased: false });
        expect(await fsReadFile(path.join(outside, 'out', 'spill.json'), 'utf8')).toBe('{"secret":1}');
        // ... with it, the content is zeroed wherever the directory went, and the hold is released.
        expect(await eraseIfSame(root, 'out/spill.json', written.dev, written.ino, holds, written.holdId)).toEqual({ erased: true });
        expect((await fsStat(path.join(outside, 'out', 'spill.json'))).size).toBe(0);
        expect(holds.size).toBe(0);
        expect(await releaseNewFile(holds, written.holdId!)).toEqual({ released: false });
      } finally {
        await holds.closeAll();
        await rm(root, { recursive: true, force: true });
        await rm(outside, { recursive: true, force: true });
      }
    });

    it('releaseNewFile closes the hold and a stale or foreign hold never erases anything', async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'xdt-hold-release-'));
      const holds = new NewFileHoldRegistry();
      try {
        const written = await writeNewFile(root, 'spill.json', '{"secret":1}', holds);
        const other = await writeNewFile(root, 'other.json', '{"b":2}', holds);
        expect(await releaseNewFile(holds, written.holdId!)).toEqual({ released: true });
        expect(holds.size).toBe(1);
        // Released hold: falls back to the pathname, which still reaches our inode.
        expect(await eraseIfSame(root, 'spill.json', written.dev, written.ino, holds, written.holdId)).toEqual({ erased: true });
        // A hold whose identity is not the requested inode is ignored; the pathname decides.
        await rm(path.join(root, 'other.json'));
        await fsWriteFile(path.join(root, 'other.json'), 'someone else');
        expect(await eraseIfSame(root, 'other.json', written.dev, written.ino, holds, other.holdId)).toEqual({ erased: false });
        expect(await fsReadFile(path.join(root, 'other.json'), 'utf8')).toBe('someone else');
        // The hold's own inode (renamed away by the workdir process) is still erasable through it.
        expect(await eraseIfSame(root, 'other.json', other.dev, other.ino, holds, other.holdId)).toEqual({ erased: true });
        expect(holds.size).toBe(0);
      } finally {
        await holds.closeAll();
        await rm(root, { recursive: true, force: true });
      }
    });

    it('verifyNewFile retains the verified descriptor as a hold', async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'xdt-hold-verify-'));
      const outside = await mkdtemp(path.join(os.tmpdir(), 'xdt-hold-verify-outside-'));
      const holds = new NewFileHoldRegistry();
      try {
        await mkdir(path.join(root, 'out'));
        const written = await writeNewFile(root, 'out/spill.json', '{"a":1}');
        const verified = await verifyNewFile(root, 'out/spill.json', sha('{"a":1}'), 7, holds);
        expect(verified).toMatchObject({ ino: written.ino, holdId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
        // Windows refuses to move a directory while a handle opened *through it* is held (the
        // verify descriptor was opened by the target path): then no move-out race exists and
        // the erase through the hold must still work in place.
        const moved = await fsp.rename(path.join(root, 'out'), path.join(outside, 'out')).then(() => true, (err: NodeJS.ErrnoException) => {
          if (process.platform === 'win32' && ['EPERM', 'EBUSY', 'EACCES'].includes(err?.code ?? '')) return false;
          throw err;
        });
        expect(await eraseIfSame(root, 'out/spill.json', verified.dev, verified.ino, holds, verified.holdId)).toEqual({ erased: true });
        expect((await fsStat(path.join(moved ? outside : root, 'out', 'spill.json'))).size).toBe(0);
        // A refused verification retains nothing.
        await fsWriteFile(path.join(root, 'r.json'), '{"a":1}');
        await expect(verifyNewFile(root, 'r.json', sha('{"a":2}'), 7, holds)).rejects.toThrow(/content mismatch/);
        expect(holds.size).toBe(0);
      } finally {
        await holds.closeAll();
        await rm(root, { recursive: true, force: true });
        await rm(outside, { recursive: true, force: true });
      }
    });

    it('holds are bounded in number (oldest evicted) and expire after their TTL', async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'xdt-hold-ttl-'));
      // Count bound: a TTL long enough that the three fsync-heavy writes (slow on Windows CI)
      // cannot expire anything while the assertions run.
      const bounded = new NewFileHoldRegistry({ ttlMs: 60_000, max: 2 });
      const expiring = new NewFileHoldRegistry({ ttlMs: 20 });
      try {
        const a = await writeNewFile(root, 'a.json', '{"a":1}', bounded);
        await writeNewFile(root, 'b.json', '{"b":1}', bounded);
        const c = await writeNewFile(root, 'c.json', '{"c":1}', bounded);
        expect(bounded.size).toBe(2);
        expect(bounded.get(a.holdId!)).toBeNull(); // oldest evicted
        expect(bounded.get(c.holdId!)).not.toBeNull();
        const d = await writeNewFile(root, 'd.json', '{"d":1}', expiring);
        await new Promise(r => setTimeout(r, 100));
        expect(expiring.size).toBe(0);
        // Expired: the published file is untouched and still erasable by pathname.
        expect(await fsReadFile(path.join(root, 'd.json'), 'utf8')).toBe('{"d":1}');
        expect(await eraseIfSame(root, 'd.json', d.dev, d.ino, expiring, d.holdId)).toEqual({ erased: true });
      } finally {
        await bounded.closeAll();
        await expiring.closeAll();
        await rm(root, { recursive: true, force: true });
      }
    });

    it('verifyNewFile also treats a staging sibling in the target directory as in flight', async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'xdt-verify-parent-staging-'));
      try {
        await mkdir(path.join(root, 'out'));
        await fsWriteFile(path.join(root, 'out', 'r.json'), '{"a":1}');
        await fsWriteFile(path.join(root, 'out', '.r.json.some-uuid.staging'), '{"a":1}');
        await expect(verifyNewFile(root, 'out/r.json', sha('{"a":1}'), 7)).rejects.toThrow(/still in flight/);
        await rm(path.join(root, 'out', '.r.json.some-uuid.staging'));
        await expect(verifyNewFile(root, 'out/r.json', sha('{"a":1}'), 7)).resolves.toMatchObject({ size: 7 });
      } finally { await rm(root, { recursive: true, force: true }); }
    });

    it('chooseStagingDir stages at the root only when the target shares its filesystem', () => {
      expect(chooseStagingDir(1n, '/wd', 1n, '/wd/out')).toBe('/wd');
      expect(chooseStagingDir(1n, '/wd', 2n, '/wd/mnt/out')).toBe('/wd/mnt/out');
    });
  });

  // Codex P1 (round 12): the parent may be moved out while the directory sync is awaited;
  // the publish is re-anchored afterwards and withdrawn (content zeroed) on mismatch.
  it('writeNewFile re-anchors after the directory sync and zeroes a file whose parent moved out', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xdt-resync-anchor-'));
    const outside = await mkdtemp(path.join(os.tmpdir(), 'xdt-resync-outside-'));
    const realOpen = fsp.open.bind(fsp);
    let moved = false;
    const spy = vi.spyOn(fsp, 'open').mockImplementation(async (...args: Parameters<typeof fsp.open>) => {
      const handle = await realOpen(...args);
      const st = await handle.stat();
      if (st.isDirectory() && String(args[0]).endsWith(`${path.sep}out`) && !moved) {
        const origSync = handle.sync.bind(handle);
        handle.sync = async () => {
          await origSync();
          // Windows refuses to move a directory holding an open handle: then no race exists.
          try {
            await fsp.rename(path.join(root, 'out'), path.join(outside, 'out'));
            moved = true;
          } catch (error) {
            if (!['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
          }
        };
      }
      return handle;
    });
    try {
      await mkdir(path.join(root, 'out'));
      const outcome = writeNewFile(root, 'out/spill.json', '{"secret":1}');
      if (process.platform === 'win32') {
        // Either the move happened (race reproduced) or the platform refused it (plain success).
        const settled = await outcome.then(() => 'resolved', (e: Error) => e.message);
        if (!moved) { expect(settled).toBe('resolved'); return; }
        expect(settled).toMatch(/escapes workdir/);
      } else {
        await expect(outcome).rejects.toThrow(/escapes workdir/);
        expect(moved).toBe(true);
      }
      const escaped = await fsStat(path.join(outside, 'out', 'spill.json')).catch(() => null);
      if (escaped) expect(escaped.size).toBe(0);
      for (const name of (await fsp.readdir(root)).filter(n => n.includes('.staging'))) {
        expect((await fsp.stat(path.join(root, name))).size).toBe(0);
      }
    } finally {
      spy.mockRestore();
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  // Codex P1 (round 12): recovery must prove the pathname still names the hashed inode.
  it('verifyNewFile rejects when the entry is renamed away while its content is being read', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xdt-verify-rename-'));
    const realOpen = fsp.open.bind(fsp);
    const spy = vi.spyOn(fsp, 'open').mockImplementation(async (...args: Parameters<typeof fsp.open>) => {
      const handle = await realOpen(...args);
      const st = await handle.stat();
      if (st.isFile()) {
        const origRead = handle.readFile.bind(handle);
        handle.readFile = (async (...readArgs: Parameters<typeof origRead>) => {
          await fsp.rename(path.join(root, 'r.json'), path.join(root, 'renamed.json'));
          return origRead(...readArgs);
        }) as typeof handle.readFile;
      }
      return handle;
    });
    try {
      await fsWriteFile(path.join(root, 'r.json'), '{"a":1}');
      await expect(verifyNewFile(root, 'r.json', sha('{"a":1}'), 7)).rejects.toThrow(/identity mismatch after read/);
    } finally {
      spy.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  // Codex P1 (round 10): erasure is bound to the inode, not the pathname. A spill renamed
  // away between identity check and unlink (modelled by a second hard link) still loses its
  // private content, while a pathname that no longer names our inode is never truncated.
  it('eraseIfSame erases the verified inode through its descriptor and leaves a replaced name alone', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xdt-erase-'));
    try {
      const written = await writeNewFile(root, 'spill.json', '{"secret":1}');
      await fsLink(path.join(root, 'spill.json'), path.join(root, 'moved-away.json'));
      expect(await eraseIfSame(root, 'spill.json', written.dev, written.ino)).toEqual({ erased: true });
      // Same inode reachable under another name: content gone, so a renamed-away copy leaks nothing.
      expect((await fsStat(path.join(root, 'moved-away.json'))).size).toBe(0);
      // A replacement that is not our inode keeps its content untouched.
      await rm(path.join(root, 'spill.json'));
      await fsWriteFile(path.join(root, 'spill.json'), 'someone else');
      expect(await eraseIfSame(root, 'spill.json', written.dev, written.ino)).toEqual({ erased: false });
      expect(await fsReadFile(path.join(root, 'spill.json'), 'utf8')).toBe('someone else');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
