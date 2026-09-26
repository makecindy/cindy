/**
 * claudeLegacyConfigMigration.test.ts —— 旧版 dev 隔离目录 claude-home 的一次性补拷。
 *
 * 契约:只补缺不覆盖、不删旧目录、保留 mtime、不跟随符号链接、不留临时文件;
 * 全部成功才写标记(之后不再扫描),有失败下次重试;正式版与非 dev 多实例不执行。
 */
import { mkdtempSync, promises as fs, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  isPackaged: false,
  userDataDir: '',
  getPathError: null as Error | null,
  getPathCalls: 0,
}));

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return h.isPackaged;
    },
    getPath: () => {
      h.getPathCalls += 1;
      if (h.getPathError) throw h.getPathError;
      return h.userDataDir;
    },
  },
}));

vi.mock('../../logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

import {
  ensureLegacyClaudeConfigMigrated,
  migrateLegacyClaudeConfigDir,
  resetLegacyClaudeConfigMigrationForTest,
} from '../claude-legacy-config-migration.js';

// Windows 默认无文件 symlink 权限时跳过真实文件系统用例;有权限的 Windows 与 POSIX 上照常实跑。
function canCreateFileSymlink(): boolean {
  const probe = mkdtempSync(path.join(os.tmpdir(), 'claude-legacy-link-probe-'));
  try {
    const target = path.join(probe, 'target');
    writeFileSync(target, 'probe');
    symlinkSync(target, path.join(probe, 'link'), 'file');
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

const canLinkFile = canCreateFileSymlink();

const MARKER = '.cindy-migrated-to-default-config';
const tempRoots: string[] = [];
const originalUserDataEnv = process.env.XDT_USER_DATA_DIR;

async function makeRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-claude-legacy-'));
  tempRoots.push(root);
  return root;
}

async function writeFileAt(file: string, content: string, mtime?: Date): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, 'utf-8');
  if (mtime) await fs.utimes(file, mtime, mtime);
}

async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out.push(path.relative(root, full));
    }
  }
  await walk(root).catch(() => undefined);
  return out.sort();
}

beforeEach(() => {
  h.isPackaged = false;
  h.userDataDir = '';
  h.getPathError = null;
  h.getPathCalls = 0;
  resetLegacyClaudeConfigMigrationForTest();
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (originalUserDataEnv === undefined) delete process.env.XDT_USER_DATA_DIR;
  else process.env.XDT_USER_DATA_DIR = originalUserDataEnv;
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('migrateLegacyClaudeConfigDir', () => {
  it('copies missing transcripts and file checkpoints, preserving mtime and the legacy dir', async () => {
    const root = await makeRoot();
    const legacyDir = path.join(root, 'user-data', 'claude-home');
    const targetDir = path.join(root, 'home', '.claude');
    const mtime = new Date('2026-09-20T08:00:00Z');
    await writeFileAt(path.join(legacyDir, 'projects', '-work', 'sid-1.jsonl'), 'legacy-1\n', mtime);
    await writeFileAt(path.join(legacyDir, 'projects', '-work', 'sid-1', 'subagents', 'agent-a.jsonl'), 'sub\n');
    await writeFileAt(path.join(legacyDir, 'file-history', 'sid-1', 'abc@v1'), 'checkpoint');
    await writeFileAt(path.join(legacyDir, 'settings.json'), '{}');

    const stats = await migrateLegacyClaudeConfigDir({ legacyDir, targetDir });

    expect(stats).toEqual({ copied: 3, skipped: 0, failed: 0 });
    expect(await listFiles(targetDir)).toEqual([
      path.join('file-history', 'sid-1', 'abc@v1'),
      path.join('projects', '-work', 'sid-1', 'subagents', 'agent-a.jsonl'),
      path.join('projects', '-work', 'sid-1.jsonl'),
    ].sort());
    const copied = path.join(targetDir, 'projects', '-work', 'sid-1.jsonl');
    await expect(fs.readFile(copied, 'utf-8')).resolves.toBe('legacy-1\n');
    expect((await fs.stat(copied)).mtimeMs).toBe(mtime.getTime());
    // 旧目录原样保留(旧 checkout 仍可能用它),并写上完成标记。
    await expect(fs.readFile(path.join(legacyDir, 'projects', '-work', 'sid-1.jsonl'), 'utf-8'))
      .resolves.toBe('legacy-1\n');
    await expect(fs.stat(path.join(legacyDir, MARKER))).resolves.toBeTruthy();
  });

  it('never overwrites a file that already exists in the default dir', async () => {
    const root = await makeRoot();
    const legacyDir = path.join(root, 'claude-home');
    const targetDir = path.join(root, '.claude');
    await writeFileAt(path.join(legacyDir, 'projects', '-work', 'sid-1.jsonl'), 'legacy\n');
    await writeFileAt(path.join(targetDir, 'projects', '-work', 'sid-1.jsonl'), 'current\n');

    const stats = await migrateLegacyClaudeConfigDir({ legacyDir, targetDir });

    expect(stats).toEqual({ copied: 0, skipped: 1, failed: 0 });
    await expect(fs.readFile(path.join(targetDir, 'projects', '-work', 'sid-1.jsonl'), 'utf-8'))
      .resolves.toBe('current\n');
  });

  it('runs once: a completed marker makes later calls a no-op', async () => {
    const root = await makeRoot();
    const legacyDir = path.join(root, 'claude-home');
    const targetDir = path.join(root, '.claude');
    await writeFileAt(path.join(legacyDir, 'projects', '-work', 'sid-1.jsonl'), 'one\n');
    await migrateLegacyClaudeConfigDir({ legacyDir, targetDir });
    await writeFileAt(path.join(legacyDir, 'projects', '-work', 'sid-2.jsonl'), 'two\n');

    await expect(migrateLegacyClaudeConfigDir({ legacyDir, targetDir })).resolves.toBeNull();
    expect(await listFiles(targetDir)).toEqual([path.join('projects', '-work', 'sid-1.jsonl')]);
  });

  it('does nothing and writes no marker when there is no legacy dir', async () => {
    const root = await makeRoot();
    const legacyDir = path.join(root, 'claude-home');
    const targetDir = path.join(root, '.claude');

    await expect(migrateLegacyClaudeConfigDir({ legacyDir, targetDir })).resolves.toBeNull();
    await expect(fs.stat(legacyDir)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(targetDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps going past a failed entry and leaves the marker unset so the next start retries', async () => {
    const root = await makeRoot();
    const legacyDir = path.join(root, 'claude-home');
    const targetDir = path.join(root, '.claude');
    await writeFileAt(path.join(legacyDir, 'projects', 'blocked', 'sid-1.jsonl'), 'blocked\n');
    await writeFileAt(path.join(legacyDir, 'projects', 'ok', 'sid-2.jsonl'), 'ok\n');
    // 目标里同名位置是普通文件,旧目录里是目录:建子目录会失败。
    await writeFileAt(path.join(targetDir, 'projects', 'blocked'), 'not a dir');

    const stats = await migrateLegacyClaudeConfigDir({ legacyDir, targetDir });

    expect(stats?.failed).toBe(1);
    expect(stats?.copied).toBe(1);
    await expect(fs.readFile(path.join(targetDir, 'projects', 'ok', 'sid-2.jsonl'), 'utf-8'))
      .resolves.toBe('ok\n');
    await expect(fs.stat(path.join(legacyDir, MARKER))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await listFiles(targetDir)).some((file) => file.endsWith('.tmp'))).toBe(false);
  });

  it('falls back to an exclusive copy when hard links are unsupported', async () => {
    const root = await makeRoot();
    const legacyDir = path.join(root, 'claude-home');
    const targetDir = path.join(root, '.claude');
    await writeFileAt(path.join(legacyDir, 'projects', '-work', 'sid-1.jsonl'), 'legacy\n');
    vi.spyOn(fs, 'link').mockRejectedValue(Object.assign(new Error('nope'), { code: 'EPERM' }));

    const stats = await migrateLegacyClaudeConfigDir({ legacyDir, targetDir });

    expect(stats).toEqual({ copied: 1, skipped: 0, failed: 0 });
    await expect(fs.readFile(path.join(targetDir, 'projects', '-work', 'sid-1.jsonl'), 'utf-8'))
      .resolves.toBe('legacy\n');
    expect(await listFiles(targetDir)).toEqual([path.join('projects', '-work', 'sid-1.jsonl')]);
  });

  it('the exclusive-copy fallback still never overwrites a file created meanwhile', async () => {
    const root = await makeRoot();
    const legacyDir = path.join(root, 'claude-home');
    const targetDir = path.join(root, '.claude');
    const target = path.join(targetDir, 'projects', '-work', 'sid-1.jsonl');
    await writeFileAt(path.join(legacyDir, 'projects', '-work', 'sid-1.jsonl'), 'legacy\n');
    // 硬链接失败的同时,目标被并发写入(CLI resume / 分享导入)。
    vi.spyOn(fs, 'link').mockImplementation(async () => {
      await fs.writeFile(target, 'current\n', 'utf-8');
      throw Object.assign(new Error('nope'), { code: 'EPERM' });
    });

    const stats = await migrateLegacyClaudeConfigDir({ legacyDir, targetDir });

    expect(stats).toEqual({ copied: 0, skipped: 1, failed: 0 });
    await expect(fs.readFile(target, 'utf-8')).resolves.toBe('current\n');
  });

  it('does not let a failed temp-file cleanup undo a successful copy', async () => {
    const root = await makeRoot();
    const legacyDir = path.join(root, 'claude-home');
    const targetDir = path.join(root, '.claude');
    await writeFileAt(path.join(legacyDir, 'projects', '-work', 'sid-1.jsonl'), 'legacy\n');
    vi.spyOn(fs, 'rm').mockRejectedValue(Object.assign(new Error('busy'), { code: 'EPERM' }));

    const stats = await migrateLegacyClaudeConfigDir({ legacyDir, targetDir });

    expect(stats).toEqual({ copied: 1, skipped: 0, failed: 0 });
    await expect(fs.stat(path.join(legacyDir, MARKER))).resolves.toBeTruthy();
  });

  it.skipIf(!canLinkFile)('does not follow symlinks out of the legacy dir', async () => {
    const root = await makeRoot();
    const legacyDir = path.join(root, 'claude-home');
    const targetDir = path.join(root, '.claude');
    const outside = path.join(root, 'outside.jsonl');
    await writeFileAt(outside, 'outside\n');
    await fs.mkdir(path.join(legacyDir, 'projects', '-work'), { recursive: true });
    await fs.symlink(outside, path.join(legacyDir, 'projects', '-work', 'linked.jsonl'));

    const stats = await migrateLegacyClaudeConfigDir({ legacyDir, targetDir });

    expect(stats).toEqual({ copied: 0, skipped: 0, failed: 0 });
    expect(await listFiles(targetDir)).toEqual([]);
  });
});

describe('ensureLegacyClaudeConfigMigrated', () => {
  async function seedDevInstance(): Promise<{ legacyDir: string; home: string }> {
    const root = await makeRoot();
    h.userDataDir = path.join(root, 'user-data');
    const home = path.join(root, 'home');
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    const legacyDir = path.join(h.userDataDir, 'claude-home');
    await writeFileAt(path.join(legacyDir, 'projects', '-work', 'sid-1.jsonl'), 'legacy\n');
    return { legacyDir, home };
  }

  it('migrates a dev multi-instance legacy dir into ~/.claude before the CLI starts', async () => {
    const { home } = await seedDevInstance();
    process.env.XDT_USER_DATA_DIR = h.userDataDir;

    await ensureLegacyClaudeConfigMigrated();

    await expect(fs.readFile(path.join(home, '.claude', 'projects', '-work', 'sid-1.jsonl'), 'utf-8'))
      .resolves.toBe('legacy\n');
  });

  it('waits only once: after the first timeout later calls return immediately', async () => {
    await seedDevInstance();
    process.env.XDT_USER_DATA_DIR = h.userDataDir;
    // 补拷卡在目录遍历上,模拟超大旧目录。
    vi.spyOn(fs, 'readdir').mockImplementation(() => new Promise<Dirent[]>(() => undefined) as never);

    await ensureLegacyClaudeConfigMigrated(5);
    const started = Date.now();
    await ensureLegacyClaudeConfigMigrated(10_000);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('never throws when the userData path is unavailable, and does not retry in the same run', async () => {
    process.env.XDT_USER_DATA_DIR = '/tmp/cindy-dev-instance';
    h.getPathError = new Error('userData not ready');

    await expect(ensureLegacyClaudeConfigMigrated()).resolves.toBeUndefined();
    await expect(ensureLegacyClaudeConfigMigrated()).resolves.toBeUndefined();
    expect(h.getPathCalls).toBe(1);
  });

  it('is a no-op in packaged builds', async () => {
    const { home } = await seedDevInstance();
    process.env.XDT_USER_DATA_DIR = h.userDataDir;
    h.isPackaged = true;

    await ensureLegacyClaudeConfigMigrated();

    await expect(fs.stat(path.join(home, '.claude'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('is a no-op without XDT_USER_DATA_DIR', async () => {
    const { home } = await seedDevInstance();
    delete process.env.XDT_USER_DATA_DIR;

    await ensureLegacyClaudeConfigMigrated();

    await expect(fs.stat(path.join(home, '.claude'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
