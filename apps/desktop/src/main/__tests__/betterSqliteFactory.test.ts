import { describe, expect, it } from 'vitest';

import path from 'node:path';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

import {
  createBetterSqliteDatabase,
  getElectronNativeBindingPath,
  resolveBetterSqliteNativeBinding,
  restrictDbFilePermissions,
} from '../localDb/betterSqliteFactory';
import { CJK_SEG_SQL_FN } from '../localDb/cjkSeg';
import { backupDb, restrictLegacyBackupPermissions } from '../localDb/backup';

// chmod / POSIX mode 位在 Windows(NTFS)上是 near-noop,权限模型不同,断言无意义;
// 仅在非 win32 平台校验 0600 收紧行为。
const itPosix = process.platform === 'win32' ? it.skip : it;

function mode(file: string): number {
  return statSync(file).mode & 0o777;
}

describe('resolveBetterSqliteNativeBinding', () => {
  it('非 Electron 环境默认不覆盖 nativeBinding', () => {
    expect(resolveBetterSqliteNativeBinding({}, { node: 'test-node' })).toBeUndefined();
  });

  it('Electron 环境优先使用显式传入的独立 native binding', () => {
    const nativeBinding = path.join('native', 'better_sqlite3.node');

    expect(
      resolveBetterSqliteNativeBinding(
        { XDT_BETTER_SQLITE3_NATIVE_BINDING: nativeBinding },
        { electron: 'test-electron', node: 'test-node' },
      ),
    ).toBe(nativeBinding);
  });

  it('Electron 环境可从独立 cache 解析当前平台的 native binding', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'xdt-better-sqlite-'));
    try {
      const nativeBinding = getElectronNativeBindingPath(
        root,
        'test-electron',
        'test-platform',
        'test-arch',
        'test-better-sqlite',
      );
      mkdirSync(path.dirname(nativeBinding), { recursive: true });
      writeFileSync(nativeBinding, '');

      expect(
        resolveBetterSqliteNativeBinding(
          {},
          { electron: 'test-electron', node: 'test-node' },
          { arch: 'test-arch', platform: 'test-platform', roots: [root], moduleVersion: 'test-better-sqlite' },
        ),
      ).toBe(nativeBinding);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('显式 packaged 标记不扫描开发 cache', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'xdt-better-sqlite-'));
    try {
      const nativeBinding = getElectronNativeBindingPath(
        root,
        'test-electron',
        'test-platform',
        'test-arch',
        'test-better-sqlite',
      );
      mkdirSync(path.dirname(nativeBinding), { recursive: true });
      writeFileSync(nativeBinding, '');

      expect(
        resolveBetterSqliteNativeBinding(
          {},
          { electron: 'test-electron', node: 'test-node' },
          {
            arch: 'test-arch',
            platform: 'test-platform',
            roots: [root],
            isPackaged: true,
            moduleVersion: 'test-better-sqlite',
          },
        ),
      ).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('restrictDbFilePermissions', () => {
  itPosix('把主库及 -wal / -shm 伴随文件收紧到 0600', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'xdt-db-perms-'));
    try {
      const dbFile = path.join(dir, 'chat.db');
      const walFile = `${dbFile}-wal`;
      const shmFile = `${dbFile}-shm`;
      for (const f of [dbFile, walFile, shmFile]) {
        writeFileSync(f, '');
        chmodSync(f, 0o644);
      }

      restrictDbFilePermissions(dbFile);

      expect(mode(dbFile)).toBe(0o600);
      expect(mode(walFile)).toBe(0o600);
      expect(mode(shmFile)).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  itPosix('伴随文件不存在时不抛错(ENOENT 静默跳过)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'xdt-db-perms-'));
    try {
      const dbFile = path.join(dir, 'chat.db');
      writeFileSync(dbFile, '');
      chmodSync(dbFile, 0o644);

      expect(() => restrictDbFilePermissions(dbFile)).not.toThrow();
      expect(mode(dbFile)).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it(':memory: / 空串 / Buffer 直接跳过,不抛错', () => {
    expect(() => restrictDbFilePermissions(':memory:')).not.toThrow();
    expect(() => restrictDbFilePermissions('')).not.toThrow();
    expect(() => restrictDbFilePermissions(Buffer.from('db'))).not.toThrow();
  });

  itPosix('路径中包含 :memory: 子串的真实文件不被跳过（精确匹配）', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'xdt-db-perms-'));
    try {
      // 文件名含 :memory: 子串，旧代码的 includes 检测会误判为内存库而跳过 chmod
      const dbFile = path.join(dir, 'chat:memory:extra.db');
      writeFileSync(dbFile, '');
      chmodSync(dbFile, 0o644);
      restrictDbFilePermissions(dbFile);
      expect(mode(dbFile)).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('restrictLegacyBackupPermissions nuke 备份', () => {
  itPosix('dev nuke 路径生成的 .bak.nuke-* 文件被收紧到 0600', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'xdt-db-nuke-'));
    try {
      const dbFile = path.join(dir, 'chat.db');
      const nukeFile = `${dbFile}.bak.nuke-2026-07-01T00-00-00-000Z`;
      writeFileSync(nukeFile, '');
      chmodSync(nukeFile, 0o644);

      restrictLegacyBackupPermissions(dbFile);

      expect(mode(nukeFile)).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('backupDb 文件权限', () => {
  itPosix('备份文件 mode 从建立之初即为 0600', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'xdt-db-backup-'));
    const dbFile = path.join(dir, 'chat.db');
    const db = createBetterSqliteDatabase(dbFile);
    try {
      const result = await backupDb(db, dbFile);
      expect(typeof result).toBe('string');
      expect(mode(result as string)).toBe(0o600);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('createBetterSqliteDatabase 文件权限', () => {
  itPosix('建库后主库文件 mode 为 0600', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'xdt-db-create-'));
    const dbFile = path.join(dir, 'chat.db');
    const db = createBetterSqliteDatabase(dbFile);
    try {
      expect(mode(dbFile)).toBe(0o600);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('createBetterSqliteDatabase 注册 cjk_seg', () => {
  it('打开连接后即可调用 cjk_seg', () => {
    const db = createBetterSqliteDatabase(':memory:');
    try {
      const row = db.prepare(`SELECT ${CJK_SEG_SQL_FN}(?) AS v`).get('边界') as { v: string };
      expect(row.v).toBe('边 界');
    } finally {
      db.close();
    }
  });
});
