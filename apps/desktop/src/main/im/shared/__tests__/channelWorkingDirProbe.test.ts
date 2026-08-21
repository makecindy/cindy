/**
 * channelWorkingDirProbe.test.ts
 * ---------------------------------------------------------------------------
 * 写探针/临时文件的所有权纪律回归(六轮 review 裁决):
 *   - 只删除**本次调用确认独占创建**的文件 — 'wx' 碰撞(EEXIST)的路径属于
 *     别人, 竞争文件必须原样保留;
 *   - 删除失败接受 0 字节 UUID 残留 — 不记住路径跨时间重试(路径可能已被
 *     其它进程替换, 重试会误删替换文件), 不做前缀扫描;
 *   - 探测不经 openSync/closeSync 手工描述符生命周期, 无句柄泄漏面。
 *
 * node:fs 被包装注入(closeSync / rmSync / writeFileSync 可控), 目录准备与
 * 残留断言走未被 mock 的 node:fs/promises。
 */

import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const failState = vi.hoisted(() => ({
  closeSyncFails: false,
  rmSyncFailuresRemaining: 0,
  probeWriteEexistNext: false,
  tmpWriteEexistNext: false,
  rmSyncCalls: [] as string[],
  openSyncCalls: [] as string[],
  writeFileSyncCalls: [] as string[],
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const wrapped = {
    ...actual,
    closeSync(fd: number) {
      if (failState.closeSyncFails) {
        const err = Object.assign(new Error('EBADF close'), {
          code: 'EBADF',
        }) as NodeJS.ErrnoException;
        throw err;
      }
      return actual.closeSync(fd);
    },
    openSync(...args: Parameters<typeof actual.openSync>) {
      failState.openSyncCalls.push(String(args[0]));
      return actual.openSync(...args);
    },
    writeFileSync(...args: Parameters<typeof actual.writeFileSync>) {
      const target = String(args[0]);
      failState.writeFileSyncCalls.push(target);
      // 模拟「其它进程抢先占住同一路径」: 真实写一份竞争内容, 再按 'wx'
      // 语义抛 EEXIST。
      const eexist =
        (failState.probeWriteEexistNext && target.includes('.cindy-workdir-probe-')) ||
        (failState.tmpWriteEexistNext && target.endsWith('.tmp'));
      if (eexist) {
        failState.probeWriteEexistNext = false;
        failState.tmpWriteEexistNext = false;
        actual.writeFileSync(target, 'foreign data');
        const err = Object.assign(new Error('EEXIST'), {
          code: 'EEXIST',
        }) as NodeJS.ErrnoException;
        throw err;
      }
      return actual.writeFileSync(...args);
    },
    rmSync(target: string, options: fs.RmOptions) {
      failState.rmSyncCalls.push(target);
      if (failState.rmSyncFailuresRemaining > 0) {
        failState.rmSyncFailuresRemaining -= 1;
        const err = Object.assign(new Error('EBUSY rm'), {
          code: 'EBUSY',
        }) as NodeJS.ErrnoException;
        throw err;
      }
      return actual.rmSync(target, options);
    },
  };
  return { ...actual, default: wrapped };
});

// factory 经 default import 消费 fs; 类型引用从 mock 模块借一个名字。
import type * as fs from 'node:fs';

import { __testing } from '../channelWorkingDirSettings';
import { writeWecomWorkingDir } from '../../wecom/channelSettings';

const fsp = await import('node:fs/promises');

let root = '';

const probeFiles = async (): Promise<string[]> =>
  (await fsp.readdir(root)).filter((n) => n.startsWith('.cindy-workdir-probe-'));

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'cindy-workdir-probe-'));
  failState.closeSyncFails = false;
  failState.rmSyncFailuresRemaining = 0;
  failState.probeWriteEexistNext = false;
  failState.tmpWriteEexistNext = false;
  failState.rmSyncCalls.length = 0;
  failState.openSyncCalls.length = 0;
  failState.writeFileSyncCalls.length = 0;
});

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

describe('isUsableWorkingDirectory 探针生命周期', () => {
  it('可写目录判定为可用且不留探针残留, 且不经手工 fd 生命周期', async () => {
    // closeSync 预置为持续抛错: 探测照常成功 = 实现根本不调用 closeSync。
    failState.closeSyncFails = true;

    expect(__testing.isUsableWorkingDirectory(root)).toBe(true);

    expect(failState.closeSyncFails).toBe(true); // 从未被消耗
    expect(failState.openSyncCalls).toEqual([]); // 不持 fd
    expect(failState.writeFileSyncCalls.length).toBe(1); // 单次独占创建
    expect(failState.rmSyncCalls.length).toBe(1);
    expect(await fsp.readdir(root)).toEqual([]);
  });

  it('目录变成文件后判定为不可用, 且不产生任何写入', async () => {
    const file = path.join(root, 'now-a-file');
    await fsp.writeFile(file, 'x');

    expect(__testing.isUsableWorkingDirectory(file)).toBe(false);
    expect(failState.writeFileSyncCalls).toEqual([]);
  });

  it('独占创建碰撞(EEXIST)时判定不可用, 竞争文件原样保留', async () => {
    failState.probeWriteEexistNext = true;

    expect(__testing.isUsableWorkingDirectory(root)).toBe(false);

    // 碰撞路径属于别人: finally 绝不删除未由本次调用创建的文件。
    const collided = failState.writeFileSyncCalls[0]!;
    expect(await fsp.readFile(collided, 'utf8')).toBe('foreign data');
    expect(failState.rmSyncCalls).toEqual([]);
  });

  it('rm 失败接受 0 字节残留; 旧路径(即使被替换)与用户同前缀文件都不再触碰', async () => {
    const userNote = path.join(root, '.cindy-workdir-probe-user-note');
    await fsp.writeFile(userNote, 'user data');

    // 探测1: 自己的探针删不掉(锁) → 残留, 但不记住路径。
    failState.rmSyncFailuresRemaining = 1;
    expect(__testing.isUsableWorkingDirectory(root)).toBe(true);
    const residue = (await probeFiles()).find((n) => n !== '.cindy-workdir-probe-user-note')!;
    expect(residue).toBeTruthy();

    // 旧路径已被「其它进程」替换成有意义内容。
    await fsp.writeFile(path.join(root, residue), 'replaced by someone else');

    // 探测2(锁解除): 只清理本次自己的探针, 不触碰旧路径, 不触碰用户文件。
    expect(__testing.isUsableWorkingDirectory(root)).toBe(true);
    expect(await fsp.readFile(path.join(root, residue), 'utf8')).toBe('replaced by someone else');
    expect(await fsp.readFile(userNote, 'utf8')).toBe('user data');
    const names = await probeFiles();
    expect(names.sort()).toEqual([residue, '.cindy-workdir-probe-user-note'].sort());
  });
});

describe('配置临时文件的所有权', () => {
  it('tmp 独占碰撞(EEXIST)时写入失败, 碰撞文件与既有配置保留', async () => {
    const selected = path.join(root, 'project');
    await fsp.mkdir(selected);
    // 已有一份合法配置, 碰撞不应破坏它。
    writeWecomWorkingDir(selected, root);
    const settingsFile = path.join(root, 'wecom-channel.json');
    const before = await fsp.readFile(settingsFile, 'utf8');

    // 清掉 setup 阶段的记录, 只观察碰撞这一次调用。
    failState.writeFileSyncCalls.length = 0;
    failState.tmpWriteEexistNext = true;
    const other = path.join(root, 'other');
    await fsp.mkdir(other);
    expect(() => writeWecomWorkingDir(other, root)).toThrow('EEXIST');

    const collided = failState.writeFileSyncCalls.find((c) => c.endsWith('.tmp'))!;
    expect(await fsp.readFile(collided, 'utf8')).toBe('foreign data');
    expect(await fsp.readFile(settingsFile, 'utf8')).toBe(before);
  });
});
