import { describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  exportPiSessions,
  parseSessionsExportArgs,
  piProjectDirName,
  type SessionExportResult,
} from './session-export.js';

const execFileAsync = promisify(execFile);

/** POSIX-only fixtures: mkfifo does not exist on Windows, and symlink creation needs privileges. */
const posixOnly = process.platform === 'win32';
/** Root ignores file modes, so permission-refusal cases cannot be exercised there. */
const runningAsRoot = typeof process.getuid === 'function' && process.getuid() === 0;

// Deliberate mock: this machine supports hard links, so the copy fallback is only reachable on a
// filesystem without them (FAT, some network mounts). A link() whose target sits under a
// directory named `.linkless` fails with EPERM, which is what such a filesystem reports; a
// stat() under `.zeroino` reports inode 0, as several network mounts do. Every other call is the
// real node:fs, so the filesystem behaviour under test is genuine.
type InoStats = Awaited<ReturnType<typeof import('node:fs/promises').stat>>;

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    stat: async (target: Parameters<typeof actual.stat>[0], ...rest: unknown[]) => {
      const info = await (actual.stat as (...args: unknown[]) => Promise<InoStats>)(target, ...rest);
      return String(target).includes('.zeroino')
        ? (Object.create(info, { ino: { value: 0, enumerable: true } }) as InoStats)
        : info;
    },
    link: async (sourcePath: string, destination: string) => {
      if (destination.includes('.linkless')) {
        const error = new Error(
          `EPERM: operation not permitted, link '${sourcePath}' -> '${destination}'`,
        ) as NodeJS.ErrnoException;
        error.code = 'EPERM';
        throw error;
      }
      return actual.link(sourcePath, destination);
    },
  };
});

async function sandbox(label: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), `cindy-session-export-${label}-`));
}

async function writeSession(file: string, cwd: string, id: string, tail = ''): Promise<string> {
  await mkdir(path.dirname(file), { recursive: true });
  const body = `${JSON.stringify({ type: 'session', version: 3, id, cwd, timestamp: '2026-01-01T00:00:00.000Z' })}\n${tail}`;
  await writeFile(file, body);
  return body;
}

async function linklessDest(box: string): Promise<string> {
  const dest = path.join(box, '.linkless-dest');
  await mkdir(dest, { recursive: true });
  return dest;
}

describe('piProjectDirName', () => {
  it('matches the folder Pi writes next to a default session', () => {
    expect(piProjectDirName('/Users/a/Code/repo')).toBe('--Users-a-Code-repo--');
    expect(piProjectDirName('/srv/app')).toBe('--srv-app--');
    expect(piProjectDirName('/')).toBe('----');
  });

  it('cannot emit a path segment from a hostile header', () => {
    expect(piProjectDirName('/../../etc')).toBe('--..-..-etc--');
    expect(piProjectDirName('..')).toBe('--..--');
    expect(piProjectDirName('C:\\work\\repo')).toBe('--C--work-repo--');
  });
});

describe('sessions export argument grammar', () => {
  it('accepts the documented flags and repeats of --source', () => {
    expect(
      parseSessionsExportArgs(['--source', '/a', '--source', '/b', '--dest', '/c', '--copy', '--dry-run']),
    ).toEqual({ sourceDirs: ['/a', '/b'], destDir: '/c', mode: 'copy', dryRun: true });
  });

  it('defaults to link mode and a real run', () => {
    expect(parseSessionsExportArgs(['--source', '/a', '--dest', '/c'])).toEqual({
      sourceDirs: ['/a'],
      destDir: '/c',
      mode: 'link',
      dryRun: false,
    });
  });

  it('refuses a typo instead of turning a preview into a real export', () => {
    for (const argv of [
      ['--source', '/a', '--dest', '/c', '--dryrun'],
      ['--source', '/a', '--dest', '/c', '--dry-run=true'],
      ['--source', '/a', '--dest', '/c', '--frobnicate'],
      ['--source', '/a', '--dest', '/c', 'stray'],
      ['--source', '/a', '--dest', '/c', '--dest', '/d'],
    ]) {
      expect(() => parseSessionsExportArgs(argv), argv.join(' ')).toThrow();
    }
  });

  it('refuses an empty or whitespace-only directory value', () => {
    expect(() => parseSessionsExportArgs(['--source', '/a', '--dest', ''])).toThrow(/missing a value/);
    expect(() => parseSessionsExportArgs(['--source', '/a', '--dest', '   '])).toThrow(/missing a value/);
    expect(() => parseSessionsExportArgs(['--source', '', '--dest', '/c'])).toThrow(/missing a value/);
  });

  it('requires a source and a destination', () => {
    expect(() => parseSessionsExportArgs(['--dest', '/c'])).toThrow(/--source/);
    expect(() => parseSessionsExportArgs(['--source', '/a'])).toThrow(/--dest/);
  });
});

describe('exporting', () => {
  it('links each transcript into its project folder', async () => {
    const box = await sandbox('link');
    const source = path.join(box, 'src');
    const dest = path.join(box, 'dest');
    const body = await writeSession(path.join(source, 'one.jsonl'), '/srv/app', 'one');

    const result = await exportPiSessions({ sourceDirs: [source], destDir: dest });

    const exported = path.join(dest, '--srv-app--', 'one.jsonl');
    expect(result).toEqual({
      added: 1,
      unchanged: 0,
      notSessions: 0,
      skipped: 0,
      problems: [],
      copyFallbacks: 0,
    });
    expect(await readFile(exported, 'utf8')).toBe(body);
    // Link mode shares the inode, so no bytes are duplicated.
    expect((await stat(exported)).ino).toBe((await stat(path.join(source, 'one.jsonl'))).ino);
    await rm(box, { recursive: true, force: true });
  });

  it('leaves a previous export untouched and reports it as unchanged', async () => {
    const box = await sandbox('rerun');
    const source = path.join(box, 'src');
    const dest = path.join(box, 'dest');
    await writeSession(path.join(source, 'one.jsonl'), '/srv/app', 'one');

    await exportPiSessions({ sourceDirs: [source], destDir: dest });
    const second = await exportPiSessions({ sourceDirs: [source], destDir: dest });

    expect(second.added).toBe(0);
    expect(second.unchanged).toBe(1);
    expect(second.problems).toEqual([]);
    await rm(box, { recursive: true, force: true });
  });

  it('never replaces a file it did not export', async () => {
    const box = await sandbox('foreign');
    const source = path.join(box, 'src');
    const dest = path.join(box, 'dest');
    await writeSession(path.join(source, 'one.jsonl'), '/srv/app', 'one');
    const projectDir = path.join(dest, '--srv-app--');
    await mkdir(projectDir, { recursive: true });
    const foreign = 'my own notes\n';
    await writeFile(path.join(projectDir, 'one.jsonl'), foreign);

    const result = await exportPiSessions({ sourceDirs: [source], destDir: dest });

    expect(result.added).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.problems).toEqual([`${path.join(projectDir, 'one.jsonl')}: exists and is not this export; left alone`]);
    expect(await readFile(path.join(projectDir, 'one.jsonl'), 'utf8')).toBe(foreign);
    await rm(box, { recursive: true, force: true });
  });

  it.skipIf(posixOnly)('reports a symlink sitting on the target instead of following it', async () => {
    const box = await sandbox('symlink-target');
    const source = path.join(box, 'src');
    const dest = path.join(box, 'dest');
    const body = await writeSession(path.join(source, 'one.jsonl'), '/srv/app', 'one');
    const projectDir = path.join(dest, '--srv-app--');
    await mkdir(projectDir, { recursive: true });
    await writeFile(path.join(box, 'elsewhere.jsonl'), body);
    await symlink(path.join(box, 'elsewhere.jsonl'), path.join(projectDir, 'one.jsonl'));

    const result = await exportPiSessions({ sourceDirs: [source], destDir: dest });

    expect(result.unchanged).toBe(0);
    expect(result.skipped).toBe(1);
    await rm(box, { recursive: true, force: true });
  });

  it('copies when asked, and recognises its own copy on the next run', async () => {
    const box = await sandbox('copy');
    const source = path.join(box, 'src');
    const dest = path.join(box, 'dest');
    const body = await writeSession(path.join(source, 'one.jsonl'), '/srv/app', 'one');

    const first = await exportPiSessions({ sourceDirs: [source], destDir: dest, mode: 'copy' });
    const second = await exportPiSessions({ sourceDirs: [source], destDir: dest, mode: 'copy' });

    const exported = path.join(dest, '--srv-app--', 'one.jsonl');
    expect(first.added).toBe(1);
    expect(second.unchanged).toBe(1);
    expect(second.problems).toEqual([]);
    expect(await readFile(exported, 'utf8')).toBe(body);
    expect((await stat(exported)).ino).not.toBe((await stat(path.join(source, 'one.jsonl'))).ino);
    await rm(box, { recursive: true, force: true });
  });

  it('converges after switching from link mode to copy mode', async () => {
    const box = await sandbox('mode-switch');
    const source = path.join(box, 'src');
    const dest = path.join(box, 'dest');
    await writeSession(path.join(source, 'one.jsonl'), '/srv/app', 'one');

    await exportPiSessions({ sourceDirs: [source], destDir: dest });
    const copied = await exportPiSessions({ sourceDirs: [source], destDir: dest, mode: 'copy' });

    expect(copied.problems).toEqual([]);
    expect(copied.unchanged).toBe(1);
    await rm(box, { recursive: true, force: true });
  });

  it('falls back to a copy where the destination cannot hold hard links', async () => {
    const box = await sandbox('fallback');
    const source = path.join(box, 'src');
    const dest = await linklessDest(box);
    await writeSession(path.join(source, 'one.jsonl'), '/srv/app', 'one');

    const first = await exportPiSessions({ sourceDirs: [source], destDir: dest });
    const second = await exportPiSessions({ sourceDirs: [source], destDir: dest });

    expect(first.added).toBe(1);
    expect(first.copyFallbacks).toBe(1);
    expect(second.unchanged).toBe(1);
    expect(second.problems).toEqual([]);
    await rm(box, { recursive: true, force: true });
  });

  it('counts files that are not sessions and skips unreadable ones', async () => {
    const box = await sandbox('kinds');
    const source = path.join(box, 'src');
    const dest = path.join(box, 'dest');
    await writeSession(path.join(source, 'one.jsonl'), '/srv/app', 'one');
    // A readable JSON line that is not a session header is not a session; an unparseable one is a
    // problem, because a truncated transcript must be reported rather than silently ignored.
    await writeFile(path.join(source, 'other.jsonl'), `${JSON.stringify({ type: 'message' })}\n`);
    await writeFile(path.join(source, 'broken.jsonl'), 'not json\n');

    const result = await exportPiSessions({ sourceDirs: [source], destDir: dest });

    expect(result.added).toBe(1);
    expect(result.notSessions).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.problems).toContain(`${path.join(source, 'broken.jsonl')}: no readable Pi session header`);
    await rm(box, { recursive: true, force: true });
  });

  it.skipIf(posixOnly)('reports a fifo carrying a transcript name instead of dropping it', async () => {
    const box = await sandbox('fifo-source');
    const source = path.join(box, 'src');
    const dest = path.join(box, 'dest');
    await writeSession(path.join(source, 'one.jsonl'), '/srv/app', 'one');
    await execFileAsync('mkfifo', [path.join(source, 'pipe.jsonl')]);

    const result = await exportPiSessions({ sourceDirs: [source], destDir: dest });

    expect(result.added).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.problems.some((p) => p.includes('not a regular file'))).toBe(true);
    await rm(box, { recursive: true, force: true });
  });

  it('treats a byte-identical file from a second source as the same transcript', async () => {
    const box = await sandbox('two-roots');
    const first = path.join(box, 'first');
    const second = path.join(box, 'second');
    const dest = path.join(box, 'dest');
    const body = await writeSession(path.join(first, 'one.jsonl'), '/srv/app', 'one');
    await mkdir(second, { recursive: true });
    await writeFile(path.join(second, 'one.jsonl'), body);

    const result = await exportPiSessions({ sourceDirs: [first, second], destDir: dest });

    expect(result.added).toBe(1);
    expect(result.unchanged).toBe(1);
    expect(result.problems).toEqual([]);
    await rm(box, { recursive: true, force: true });
  });
});

describe('identity', () => {
  it('reports a same-size file whose bytes differ', async () => {
    const box = await sandbox('same-size');
    const source = path.join(box, 'src');
    const dest = path.join(box, 'dest');
    const body = await writeSession(path.join(source, 'one.jsonl'), '/srv/app', 'one');
    const projectDir = path.join(dest, '--srv-app--');
    await mkdir(projectDir, { recursive: true });
    await writeFile(path.join(projectDir, 'one.jsonl'), body.replace('2026', '2027'));

    const result = await exportPiSessions({ sourceDirs: [source], destDir: dest, mode: 'copy' });

    expect(result.unchanged).toBe(0);
    expect(result.skipped).toBe(1);
    await rm(box, { recursive: true, force: true });
  });

  it('does not trust an inode number alone when filesystems collide', async () => {
    const box = await sandbox('colliding-inode');
    const source = path.join(box, 'src');
    const dest = path.join(box, '.zeroino-dest');
    await mkdir(dest, { recursive: true });
    const body = await writeSession(path.join(source, 'one.jsonl'), '/srv/app', 'one');
    const projectDir = path.join(dest, '--srv-app--');
    await mkdir(projectDir, { recursive: true });
    await writeFile(path.join(projectDir, 'one.jsonl'), body.replace('2026', '2027'));

    const result = await exportPiSessions({ sourceDirs: [source], destDir: dest, mode: 'copy' });

    expect(result.unchanged).toBe(0);
    expect(result.skipped).toBe(1);
    await rm(box, { recursive: true, force: true });
  });
});

describe('dry run', () => {
  it('reports what it would add and writes nothing', async () => {
    const box = await sandbox('dry');
    const source = path.join(box, 'src');
    const dest = path.join(box, 'dest');
    await writeSession(path.join(source, 'one.jsonl'), '/srv/app', 'one');

    const preview = await exportPiSessions({ sourceDirs: [source], destDir: dest, dryRun: true });
    const real = await exportPiSessions({ sourceDirs: [source], destDir: dest });

    expect(preview.added).toBe(1);
    expect(preview.problems).toEqual([]);
    expect(real.added).toBe(1);
    await rm(box, { recursive: true, force: true });
  });

  // `chmod` is a no-op for this probe on Windows, where the directory would stay writable.
  it.skipIf(runningAsRoot || posixOnly)('predicts an unwritable destination root', async () => {
    const box = await sandbox('dry-unwritable');
    const source = path.join(box, 'src');
    const dest = path.join(box, 'dest');
    const parent = path.join(box, 'parent');
    await mkdir(parent, { recursive: true });
    await writeSession(path.join(source, 'one.jsonl'), '/srv/app', 'one');
    await chmod(parent, 0o555);

    try {
      const preview = await exportPiSessions({
        sourceDirs: [source],
        destDir: path.join(parent, 'dest'),
        dryRun: true,
      });
      expect(preview.added).toBe(0);
      expect(preview.problems.some((p) => p.includes('not writable'))).toBe(true);
    } finally {
      await chmod(parent, 0o755);
      await rm(box, { recursive: true, force: true });
    }
  });

  it.skipIf(posixOnly)('refuses a destination below a dangling symlink, as the real run would', async () => {
    const box = await sandbox('dry-dangling');
    const source = path.join(box, 'src');
    await writeSession(path.join(source, 'one.jsonl'), '/srv/app', 'one');
    await symlink(path.join(box, 'never-created'), path.join(box, 'link'));

    const preview = await exportPiSessions({
      sourceDirs: [source],
      destDir: path.join(box, 'link', 'nested'),
      dryRun: true,
    });

    expect(preview.added).toBe(0);
    expect(preview.problems.some((p) => p.includes('symlink that does not resolve'))).toBe(true);
    await rm(box, { recursive: true, force: true });
  });

  it.skipIf(posixOnly)('refuses a project folder that is a symlink out of the destination', async () => {
    const box = await sandbox('dry-folder-symlink');
    const source = path.join(box, 'src');
    const dest = path.join(box, 'dest');
    await writeSession(path.join(source, 'one.jsonl'), '/srv/app', 'one');
    await mkdir(dest, { recursive: true });
    await mkdir(path.join(box, 'outside'), { recursive: true });
    await symlink(path.join(box, 'outside'), path.join(dest, '--srv-app--'));

    for (const dryRun of [true, false]) {
      const result = await exportPiSessions({ sourceDirs: [source], destDir: dest, dryRun });
      expect(result.added).toBe(0);
      expect(result.problems.some((p) => p.includes('project folder'))).toBe(true);
    }
    await rm(box, { recursive: true, force: true });
  });
});

describe('containment', () => {
  it('refuses a destination inside a source', async () => {
    const box = await sandbox('contained');
    const source = path.join(box, 'src');
    await writeSession(path.join(source, 'one.jsonl'), '/srv/app', 'one');

    const result = await exportPiSessions({ sourceDirs: [source], destDir: path.join(source, 'out') });

    expect(result.added).toBe(0);
    expect(result.problems.some((p) => p.includes('destination is inside source directory'))).toBe(true);
    expect(await lstat(path.join(source, 'out')).catch(() => null)).toBeNull();
    await rm(box, { recursive: true, force: true });
  });

  it.skipIf(posixOnly)('refuses a destination that only resolves inside a source', async () => {
    const box = await sandbox('contained-realpath');
    const source = path.join(box, 'src');
    await writeSession(path.join(source, 'one.jsonl'), '/srv/app', 'one');
    await symlink(source, path.join(box, 'into-src'));

    const result = await exportPiSessions({ sourceDirs: [source], destDir: path.join(box, 'into-src', 'out') });

    expect(result.added).toBe(0);
    expect(result.problems.some((p) => p.includes('destination is inside source directory'))).toBe(true);
    await rm(box, { recursive: true, force: true });
  });
});

describe('concurrent runs', () => {
  it('keeps every transcript exactly once when two runs race', async () => {
    const box = await sandbox('race');
    const source = path.join(box, 'src');
    const dest = path.join(box, 'dest');
    for (let index = 0; index < 8; index += 1) {
      await writeSession(path.join(source, `s${index}.jsonl`), '/srv/app', `s${index}`);
    }

    const [left, right] = await Promise.all([
      exportPiSessions({ sourceDirs: [source], destDir: dest }),
      exportPiSessions({ sourceDirs: [source], destDir: dest }),
    ]);

    const exported = await readdir(path.join(dest, '--srv-app--'));
    expect(exported.filter((name) => name.endsWith('.jsonl')).sort()).toEqual(
      Array.from({ length: 8 }, (_, index) => `s${index}.jsonl`).sort(),
    );
    // Neither run may claim to have written a file the other wrote; together they added eight.
    expect(left.added + right.added).toBe(8);
    expect([...left.problems, ...right.problems]).toEqual([]);
    await rm(box, { recursive: true, force: true });
  });
});

describe('result shape', () => {
  it('starts every counter at zero', async () => {
    const box = await sandbox('empty');
    const source = path.join(box, 'src');
    const dest = path.join(box, 'dest');
    await mkdir(source, { recursive: true });

    const result: SessionExportResult = await exportPiSessions({ sourceDirs: [source], destDir: dest });

    expect(result).toEqual({
      added: 0,
      unchanged: 0,
      notSessions: 0,
      skipped: 0,
      problems: [],
      copyFallbacks: 0,
    });
    await rm(box, { recursive: true, force: true });
  });

  it('reports a source that is not a directory', async () => {
    const box = await sandbox('bad-source');
    const dest = path.join(box, 'dest');
    await writeFile(path.join(box, 'file'), 'x');

    const result = await exportPiSessions({ sourceDirs: [path.join(box, 'file')], destDir: dest });

    expect(result.problems.some((p) => p.includes('not a readable directory'))).toBe(true);
    await rm(box, { recursive: true, force: true });
  });
});

describe('copy fallback without hard links', () => {
  it('copies a transcript whose parent appeared during the run', async () => {
    const box = await sandbox('fallback-nested');
    const source = path.join(box, 'src');
    const dest = await linklessDest(box);
    await writeSession(path.join(source, 'nested', 'one.jsonl'), '/srv/app', 'one');

    const result = await exportPiSessions({ sourceDirs: [source], destDir: dest });

    expect(result.added).toBe(1);
    expect(
      await readFile(path.join(dest, '--srv-app--', 'one.jsonl'), 'utf8'),
    ).toContain('"cwd":"/srv/app"');
    await rm(box, { recursive: true, force: true });
  });

  it('does not leave a partial file behind after a fallback copy', async () => {
    const box = await sandbox('fallback-partial');
    const source = path.join(box, 'src');
    const dest = await linklessDest(box);
    await writeSession(path.join(source, 'one.jsonl'), '/srv/app', 'one');

    await exportPiSessions({ sourceDirs: [source], destDir: dest });

    const names = await readdir(path.join(dest, '--srv-app--'));
    expect(names.filter((name) => name.includes('.partial-'))).toEqual([]);
    await rm(box, { recursive: true, force: true });
  });
});

describe('preserved mtime', () => {
  it('gives the exported copy the source timestamp', async () => {
    const box = await sandbox('mtime');
    const source = path.join(box, 'src');
    const dest = await linklessDest(box);
    const file = path.join(source, 'one.jsonl');
    await writeSession(file, '/srv/app', 'one');
    const stamp = new Date('2025-05-05T05:05:05Z');
    await utimes(file, stamp, stamp);

    await exportPiSessions({ sourceDirs: [source], destDir: dest });

    const exported = await stat(path.join(dest, '--srv-app--', 'one.jsonl'));
    expect(Math.round(exported.mtimeMs / 1000)).toBe(Math.round(stamp.getTime() / 1000));
    await rm(box, { recursive: true, force: true });
  });
});

describe('destination root', () => {
  it('refuses a destination that is a file', async () => {
    const box = await sandbox('dest-file');
    const source = path.join(box, 'src');
    await writeSession(path.join(source, 'one.jsonl'), '/srv/app', 'one');
    const dest = path.join(box, 'dest');
    await writeFile(dest, 'not a directory');

    const result = await exportPiSessions({ sourceDirs: [source], destDir: dest });

    expect(result.added).toBe(0);
    expect(result.problems.some((p) => p.includes('destination exists and is not a directory'))).toBe(true);
    await rm(box, { recursive: true, force: true });
  });

  it('creates a missing destination', async () => {
    const box = await sandbox('dest-create');
    const source = path.join(box, 'src');
    await writeSession(path.join(source, 'one.jsonl'), '/srv/app', 'one');

    const dest = path.join(box, 'made', 'here');
    const result = await exportPiSessions({ sourceDirs: [source], destDir: dest });

    expect(result.added).toBe(1);
    expect(await realpath(dest)).toBe(await realpath(path.join(box, 'made', 'here')));
    await rm(box, { recursive: true, force: true });
  });
});

describe('no-replace on a filesystem without hard links', () => {
  it('lets exactly one of two racing runs publish a contested name', async () => {
    const box = await sandbox('linkless-race');
    const left = path.join(box, 'left');
    const right = path.join(box, 'right');
    const dest = await linklessDest(box);
    // Different transcripts, same destination name: only one may win, and neither may replace
    // the other's bytes.
    const mine = await writeSession(path.join(left, 'one.jsonl'), '/srv/app', 'one');
    const theirs = await writeSession(path.join(right, 'one.jsonl'), '/srv/app', 'one', 'extra\n');

    const [first, second] = await Promise.all([
      exportPiSessions({ sourceDirs: [left], destDir: dest }),
      exportPiSessions({ sourceDirs: [right], destDir: dest }),
    ]);

    const exported = await readFile(path.join(dest, '--srv-app--', 'one.jsonl'), 'utf8');
    expect([mine, theirs]).toContain(exported);
    expect(first.added + second.added).toBe(1);
    expect(first.skipped + second.skipped).toBe(1);
    await rm(box, { recursive: true, force: true });
  });
});

describe('review round: identity and long names', () => {
  it('compares bytes even when an inode looks identical', async () => {
    const box = await sandbox('colliding-inodes');
    const source = path.join(box, 'src');
    const dest = path.join(box, 'dest');
    const body = await writeSession(path.join(source, 'one.jsonl'), '/srv/app', 'one');
    const projectDir = path.join(dest, '--srv-app--');
    await mkdir(projectDir, { recursive: true });
    // Same size, different bytes: only the comparison can tell, and a mount that reports the same
    // dev/ino for both must not override it.
    const other = body.replace('2026', '2027');
    expect(other).toHaveLength(body.length);
    await writeFile(path.join(projectDir, 'one.jsonl'), other);

    const result = await exportPiSessions({ sourceDirs: [source], destDir: dest, mode: 'copy' });

    expect(result.unchanged).toBe(0);
    expect(result.skipped).toBe(1);
    expect(await readFile(path.join(projectDir, 'one.jsonl'), 'utf8')).toBe(other);
    await rm(box, { recursive: true, force: true });
  });

  it('copies a name that is legal until a suffix would be appended', async () => {
    const box = await sandbox('long-name');
    const source = path.join(box, 'src');
    const dest = await linklessDest(box);
    // 246 bytes plus `.partial-<uuid>` used to exceed the 255-byte component limit.
    const name = `${'a'.repeat(241)}.jsonl`;
    await writeSession(path.join(source, name), '/srv/app', 'one');

    const preview = await exportPiSessions({ sourceDirs: [source], destDir: dest, dryRun: true });
    const real = await exportPiSessions({ sourceDirs: [source], destDir: dest });

    expect(preview.added).toBe(1);
    expect(real.added).toBe(1);
    expect(real.problems).toEqual([]);
    await rm(box, { recursive: true, force: true });
  });

  it('names a leftover placeholder from an older build without deleting it', async () => {
    const box = await sandbox('legacy-placeholder');
    const source = path.join(box, 'src');
    const dest = path.join(box, 'dest');
    await writeSession(path.join(source, 'one.jsonl'), '/srv/app', 'one');
    const projectDir = path.join(dest, '--srv-app--');
    await mkdir(projectDir, { recursive: true });
    const placeholder = path.join(projectDir, 'one.jsonl');
    const content = 'cindy-sessions-export-reservation:0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0\n';
    await writeFile(placeholder, content);

    const result = await exportPiSessions({ sourceDirs: [source], destDir: dest });

    expect(result.skipped).toBe(1);
    expect(result.problems.some((p) => p.includes('left by an older build'))).toBe(true);
    expect(await readFile(placeholder, 'utf8')).toBe(content);
    await rm(box, { recursive: true, force: true });
  });
});

describe('recovering an interrupted claim', () => {
  it('reports a claim left by an interrupted run instead of deleting it', async () => {
    const box = await sandbox('claim-recover');
    const source = path.join(box, 'src');
    const dest = await linklessDest(box);
    await writeSession(path.join(source, 'one.jsonl'), '/srv/app', 'one');
    const projectDir = path.join(dest, '--srv-app--');
    await mkdir(projectDir, { recursive: true });
    // Exactly what a run killed between its claim and its rename leaves behind.
    const claim = path.join(projectDir, 'one.jsonl');
    await writeFile(
      claim,
      'cindy-sessions-export-claim:0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0\n',
    );
    const old = new Date(Date.now() - 10 * 60 * 1000);
    await utimes(claim, old, old);

    const result = await exportPiSessions({ sourceDirs: [source], destDir: dest, claimWaitMs: 0 });

    // Deleting it would be a check-then-delete race against a resumed writer, so the run reports
    // the claim and leaves the name to its owner.
    expect(result.added).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.problems.some((p) => p.includes('claim left by an interrupted run'))).toBe(true);
    expect(await readFile(claim, 'utf8')).toContain('cindy-sessions-export-claim:');
    await rm(box, { recursive: true, force: true });
  });

  it('leaves a fresh claim alone, because its writer is still working', async () => {
    const box = await sandbox('claim-live');
    const source = path.join(box, 'src');
    const dest = await linklessDest(box);
    await writeSession(path.join(source, 'one.jsonl'), '/srv/app', 'one');
    const projectDir = path.join(dest, '--srv-app--');
    await mkdir(projectDir, { recursive: true });
    const claim = path.join(projectDir, 'one.jsonl');
    const content = 'cindy-sessions-export-claim:0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0\n';
    await writeFile(claim, content);

    const result = await exportPiSessions({ sourceDirs: [source], destDir: dest, claimWaitMs: 0 });

    expect(result.added).toBe(0);
    expect(result.skipped).toBe(1);
    expect(await readFile(claim, 'utf8')).toBe(content);
    await rm(box, { recursive: true, force: true });
  });
});

describe('staging leftovers', () => {
  it('reports an aged staging file without deleting it', async () => {
    const box = await sandbox('stale-partial');
    const source = path.join(box, 'src');
    const dest = path.join(box, 'dest');
    await writeSession(path.join(source, 'one.jsonl'), '/srv/app', 'one');
    const projectDir = path.join(dest, '--srv-app--');
    await mkdir(projectDir, { recursive: true });
    const staged = path.join(projectDir, '.partial-0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0');
    await writeFile(staged, 'half a transcript');
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(staged, old, old);

    const result = await exportPiSessions({ sourceDirs: [source], destDir: dest });

    expect(result.added).toBe(1);
    expect(result.problems.some((p) => p.includes('staging file left by an interrupted run'))).toBe(true);
    expect(await readFile(staged, 'utf8')).toBe('half a transcript');
    await rm(box, { recursive: true, force: true });
  });

  it('ignores a staging file a running copy could still own', async () => {
    const box = await sandbox('fresh-partial');
    const source = path.join(box, 'src');
    const dest = path.join(box, 'dest');
    await writeSession(path.join(source, 'one.jsonl'), '/srv/app', 'one');
    const projectDir = path.join(dest, '--srv-app--');
    await mkdir(projectDir, { recursive: true });
    await writeFile(path.join(projectDir, '.partial-0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0'), 'copying');

    const result = await exportPiSessions({ sourceDirs: [source], destDir: dest });

    expect(result.problems).toEqual([]);
    await rm(box, { recursive: true, force: true });
  });
});
