/**
 * backup.ts 单测——2026-07 备份体积失控事故的回归覆盖：
 *   - pruneIsoBackupsToBudget：份数 + 总体积双上限、keepNewest 语义、.bak.clean 隔离
 *   - isoBackupTotalBudgetBytes：大库自动收缩份数、小库保底预算
 *   - cleanupFailedBackupArtifacts：失败备份的 -journal 残留一并清理
 *   - estimateDbSizeBytes：db + WAL 求和
 *
 * 全部用 os.tmpdir() 下的临时目录制造假备份文件（规则 23：不落仓库工作区）。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  cleanupFailedBackupArtifacts,
  estimateDbSizeBytes,
  getFreeDiskBytes,
  isoBackupTotalBudgetBytes,
  listIsoBackups,
  pruneIsoBackupsToBudget,
  tryRestoreWithFallback,
} from '../backup';

const GB = 1024 ** 3;

let tmpDir: string;
let dbFilePath: string;

/** 造一个指定"名义大小"的假备份文件——真写 size 字节太慢，用 truncate 打洞。 */
function makeBackup(iso: string, sizeBytes: number): string {
  const p = `${dbFilePath}.bak.${iso}`;
  const fd = fs.openSync(p, 'w');
  fs.ftruncateSync(fd, sizeBytes);
  fs.closeSync(fd);
  return p;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-backup-test-'));
  dbFilePath = path.join(tmpDir, 'xdt-maker-test.db');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('pruneIsoBackupsToBudget', () => {
  it('小库场景：3 份小备份都在预算内 → 全保留', () => {
    makeBackup('2026-07-01T00-00-00-000Z', 100);
    makeBackup('2026-07-02T00-00-00-000Z', 100);
    makeBackup('2026-07-03T00-00-00-000Z', 100);
    const removed = pruneIsoBackupsToBudget(dbFilePath, {
      maxCount: 3,
      maxTotalBytes: 3 * GB,
    });
    expect(removed).toEqual([]);
    expect(listIsoBackups(dbFilePath)).toHaveLength(3);
  });

  it('份数超上限 → 删最旧的', () => {
    const oldest = makeBackup('2026-07-01T00-00-00-000Z', 100);
    makeBackup('2026-07-02T00-00-00-000Z', 100);
    makeBackup('2026-07-03T00-00-00-000Z', 100);
    makeBackup('2026-07-04T00-00-00-000Z', 100);
    const removed = pruneIsoBackupsToBudget(dbFilePath, {
      maxCount: 3,
      maxTotalBytes: 3 * GB,
    });
    expect(removed).toEqual([oldest]);
    expect(listIsoBackups(dbFilePath)).toHaveLength(3);
  });

  it('大库场景（事故回归）：总体积超预算 → 只留最新一份', () => {
    // 模拟 13GB 库、budget = 1.5×13 = 19.5GB：留下最新 13GB 后，再往旧一份就超预算
    const b1 = makeBackup('2026-06-29T00-00-00-000Z', 13 * GB);
    const b2 = makeBackup('2026-07-01T00-00-00-000Z', 13 * GB);
    const b3 = makeBackup('2026-07-06T00-00-00-000Z', 13 * GB);
    const removed = pruneIsoBackupsToBudget(dbFilePath, {
      maxCount: 3,
      maxTotalBytes: isoBackupTotalBudgetBytes(13 * GB),
    });
    expect(removed.sort()).toEqual([b1, b2].sort());
    expect(listIsoBackups(dbFilePath)).toEqual([b3]);
  });

  it('keepNewest 默认 true：最新一份即使单份超预算也保留', () => {
    const only = makeBackup('2026-07-06T00-00-00-000Z', 13 * GB);
    const removed = pruneIsoBackupsToBudget(dbFilePath, {
      maxCount: 3,
      maxTotalBytes: 1 * GB,
    });
    expect(removed).toEqual([]);
    expect(listIsoBackups(dbFilePath)).toEqual([only]);
  });

  it('keepNewest=false（备份前腾预算）：预算为 0 时可清空全部旧备份', () => {
    makeBackup('2026-07-01T00-00-00-000Z', 13 * GB);
    makeBackup('2026-07-06T00-00-00-000Z', 13 * GB);
    const removed = pruneIsoBackupsToBudget(dbFilePath, {
      maxCount: 0,
      maxTotalBytes: 0,
      keepNewest: false,
    });
    expect(removed).toHaveLength(2);
    expect(listIsoBackups(dbFilePath)).toEqual([]);
  });

  it('不触碰 .bak.clean（ADR-FE9 配额隔离）', () => {
    const clean = `${dbFilePath}.bak.clean`;
    fs.writeFileSync(clean, 'clean');
    makeBackup('2026-07-01T00-00-00-000Z', 100);
    pruneIsoBackupsToBudget(dbFilePath, {
      maxCount: 0,
      maxTotalBytes: 0,
      keepNewest: false,
    });
    expect(fs.existsSync(clean)).toBe(true);
  });

  it('不识别或清理数据库瘦身备份', () => {
    const slimming = `${dbFilePath}.slimming-backup`;
    fs.writeFileSync(slimming, 'slimming');
    makeBackup('2026-07-01T00-00-00-000Z', 100);

    expect(listIsoBackups(dbFilePath)).toHaveLength(1);
    pruneIsoBackupsToBudget(dbFilePath, {
      maxCount: 0,
      maxTotalBytes: 0,
      keepNewest: false,
    });

    expect(fs.readFileSync(slimming, 'utf8')).toBe('slimming');
  });
});

describe('isoBackupTotalBudgetBytes', () => {
  it('小库走 3GB 保底', () => {
    expect(isoBackupTotalBudgetBytes(100 * 1024 * 1024)).toBe(3 * GB);
  });
  it('大库按 1.5 倍 db 大小', () => {
    expect(isoBackupTotalBudgetBytes(13 * GB)).toBe(Math.floor(13 * GB * 1.5));
  });
});

describe('tryRestoreWithFallback', () => {
  it('自动损坏恢复不会读取数据库瘦身备份', () => {
    fs.writeFileSync(`${dbFilePath}.slimming-backup`, 'not an automatic recovery source');

    expect(tryRestoreWithFallback(dbFilePath)).toBeNull();
    expect(fs.existsSync(dbFilePath)).toBe(false);
  });
});

describe('cleanupFailedBackupArtifacts', () => {
  it('本体 + -journal/-wal/-shm 残留一并删除', () => {
    const backupPath = `${dbFilePath}.bak.2026-07-06T00-00-00-000Z`;
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      fs.writeFileSync(`${backupPath}${suffix}`, 'x');
    }
    cleanupFailedBackupArtifacts(backupPath);
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      expect(fs.existsSync(`${backupPath}${suffix}`)).toBe(false);
    }
  });

  it('文件不存在时静默通过', () => {
    expect(() => cleanupFailedBackupArtifacts(`${dbFilePath}.bak.none`)).not.toThrow();
  });
});

describe('estimateDbSizeBytes', () => {
  it('db 主文件 + WAL 求和；缺失文件计 0', () => {
    fs.writeFileSync(dbFilePath, Buffer.alloc(1000));
    expect(estimateDbSizeBytes(dbFilePath)).toBe(1000);
    fs.writeFileSync(`${dbFilePath}-wal`, Buffer.alloc(500));
    expect(estimateDbSizeBytes(dbFilePath)).toBe(1500);
    expect(estimateDbSizeBytes(path.join(tmpDir, 'missing.db'))).toBe(0);
  });
});

describe('getFreeDiskBytes', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('正常返回 bsize * bavail', () => {
    vi.spyOn(fs, 'statfsSync').mockReturnValue({
      bsize: 4096,
      bavail: 1000,
    } as any);
    expect(getFreeDiskBytes(tmpDir)).toBe(4096 * 1000);
  });

  it('statfsSync 不可用时返回 null', () => {
    const original = fs.statfsSync;
    Object.defineProperty(fs, 'statfsSync', { value: 'not-a-function', configurable: true });
    try {
      expect(getFreeDiskBytes(tmpDir)).toBeNull();
    } finally {
      Object.defineProperty(fs, 'statfsSync', { value: original, configurable: true });
    }
  });

  it('statfsSync 抛出异常时返回 null', () => {
    vi.spyOn(fs, 'statfsSync').mockImplementation(() => {
      throw new Error('ENOENT');
    });
    expect(getFreeDiskBytes(tmpDir)).toBeNull();
  });
});
