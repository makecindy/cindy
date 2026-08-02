import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AtomicBackupUnrecoverableError,
  atomicWriteFileSync,
  readAtomicFileSync,
} from '../atomicWriteFile';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function makeFile(contents = 'old'): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-atomic-write-'));
  roots.push(root);
  const file = path.join(root, 'state.json');
  fs.writeFileSync(file, contents);
  return file;
}

describe('atomicWriteFileSync', () => {
  it('writes new contents replacing the existing file', () => {
    const file = makeFile();
    atomicWriteFileSync(file, 'new');
    expect(fs.readFileSync(file, 'utf8')).toBe('new');
    const dir = path.dirname(file);
    expect(fs.readdirSync(dir).filter((n) => n !== 'state.json')).toEqual([]);
  });

  it('creates the parent directory when missing', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-atomic-write-'));
    roots.push(root);
    const file = path.join(root, 'nested', 'deep', 'state.json');
    atomicWriteFileSync(file, 'created');
    expect(fs.readFileSync(file, 'utf8')).toBe('created');
  });

  it('restores a missing main file from .bak before writing', () => {
    const file = makeFile();
    // 模拟上次 temp 落位与恢复都失败:主文件缺失,.bak 是唯一快照。
    fs.renameSync(file, `${file}.bak`);
    expect(fs.existsSync(file)).toBe(false);
    atomicWriteFileSync(file, 'next');
    // 先把 .bak 恢复回主文件再写入新内容,唯一快照不被覆盖丢失。
    expect(fs.readFileSync(file, 'utf8')).toBe('next');
    expect(fs.existsSync(`${file}.bak`)).toBe(false);
  });

  it('clears a stale .bak from a previous failed write before writing', () => {
    const file = makeFile();
    fs.writeFileSync(`${file}.bak`, 'stale-backup');
    atomicWriteFileSync(file, 'fresh');
    expect(fs.readFileSync(file, 'utf8')).toBe('fresh');
    expect(fs.existsSync(`${file}.bak`)).toBe(false);
  });

  it('retries a transient EBUSY rename (Windows AV/索引器持句柄)而非硬失败', () => {
    const file = makeFile('old');
    const realRename = fs.renameSync;
    let flaky = 2; // 前两次抛 EBUSY,第三次放行
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation(((from: string, to: string) => {
      if (String(from).endsWith('.tmp') && flaky > 0) {
        flaky -= 1;
        throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
      }
      return realRename(from as never, to as never);
    }) as typeof fs.renameSync);
    try {
      atomicWriteFileSync(file, 'new');
      expect(fs.readFileSync(file, 'utf8')).toBe('new');
    } finally {
      spy.mockRestore();
    }
  });

  it('已成功落位后清理 .bak 失败不把成功报成失败', () => {
    // Windows 上 AV 占用刚生成的 .bak 会让 rm 抛 EPERM/EBUSY;这发生在 rename
    // 成功**之后**,不能反过来让整个写入抛错。这里用 EEXIST 触发备份交换分支,
    // 再让 .bak 的 rm 抛错,断言写入仍成功。
    const file = makeFile('old');
    const realRename = fs.renameSync;
    let firstTmpRename = true;
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation(((from: string, to: string) => {
      if (String(from).endsWith('.tmp') && String(to) === file && firstTmpRename) {
        firstTmpRename = false;
        throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' }); // 逼入备份交换
      }
      return realRename(from as never, to as never);
    }) as typeof fs.renameSync);
    const realRm = fs.rmSync;
    const rmSpy = vi.spyOn(fs, 'rmSync').mockImplementation(((target: string, opts?: fs.RmOptions) => {
      if (String(target) === `${file}.bak`) {
        throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
      }
      return realRm(target as never, opts as never);
    }) as typeof fs.rmSync);
    try {
      expect(() => atomicWriteFileSync(file, 'new')).not.toThrow();
      expect(fs.readFileSync(file, 'utf8')).toBe('new');
    } finally {
      renameSpy.mockRestore();
      rmSpy.mockRestore();
    }
  });
});

describe('readAtomicFileSync', () => {
  it('returns the main file contents when present', () => {
    const file = makeFile('kept');
    expect(readAtomicFileSync(file)).toBe('kept');
  });

  it('returns null when neither the main file nor .bak exists', () => {
    const file = makeFile();
    fs.rmSync(file);
    expect(readAtomicFileSync(file)).toBeNull();
  });

  it('rethrows non-ENOENT read failures instead of reporting empty', () => {
    const file = makeFile('real-content');
    // 文件明明在,只是被 Windows 文件锁/权限/瞬时 I/O 挡住。返回 null 会让调用方
    // 解释成空状态,那次写入随即用空状态派生的快照覆盖真实内容。
    const spy = vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
      throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
    });
    try {
      expect(() => readAtomicFileSync(file)).toThrow(/EBUSY/);
    } finally {
      spy.mockRestore();
    }
    // 真的不存在时仍按"空"处理。
    fs.rmSync(file);
    expect(readAtomicFileSync(file)).toBeNull();
  });

  it('throws instead of reporting empty when the .bak cannot be restored', () => {
    const file = makeFile('only-snapshot');
    fs.renameSync(file, `${file}.bak`);
    // 模拟 Windows 文件锁/杀毒占用:恢复用的 rename 失败。
    const renameSync = fs.renameSync;
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation(((from: string, to: string) => {
      if (String(from) === `${file}.bak`) {
        throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
      }
      return renameSync(from as never, to as never);
    }) as typeof fs.renameSync);
    try {
      // 关键:不能降级成 null。降级 = 调用方读成空数据 → 写入 → 主文件出现 →
      // 下一次写入把 .bak 当陈旧残留删掉,唯一有效快照永久丢失。
      expect(() => readAtomicFileSync(file)).toThrow(AtomicBackupUnrecoverableError);
      // 写入侧同样必须拒绝,不能用派生自空数据的内容覆盖唯一快照。
      expect(() => atomicWriteFileSync(file, '{}')).toThrow(AtomicBackupUnrecoverableError);
      expect(fs.readFileSync(`${file}.bak`, 'utf8')).toBe('only-snapshot');
      expect(fs.existsSync(file)).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('restores and reads .bak when the main file is missing', () => {
    const file = makeFile('only-snapshot');
    // 主文件缺失、.bak 是唯一快照:读取入口必须先恢复再读。只在写入侧恢复时,
    // 调用方会先把这里读成空数据,再拿空数据发起写入把唯一快照覆盖掉。
    fs.renameSync(file, `${file}.bak`);
    expect(readAtomicFileSync(file)).toBe('only-snapshot');
    expect(fs.readFileSync(file, 'utf8')).toBe('only-snapshot');
    expect(fs.existsSync(`${file}.bak`)).toBe(false);
  });
});
