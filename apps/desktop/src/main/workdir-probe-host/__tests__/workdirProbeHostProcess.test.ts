/**
 * workdirProbeHostProcess worker 函数的单测(纯函数直测, 不拉起子进程)。
 * 'wx' 独占创建/只删本次确认创建的探针/不前缀扫描的所有权纪律与
 * im/shared 的进程内执行器同源, 这里锁子进程侧的同一套语义。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const failState = vi.hoisted(() => ({
  probeWriteEexistNext: false,
  rmFailuresRemaining: 0,
  writeFileCalls: [] as string[],
  rmCalls: [] as string[],
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const isProbe = (target: string) => target.includes('.cindy-workdir-probe-');
  return {
    ...actual,
    async writeFile(
      target: Parameters<typeof actual.writeFile>[0],
      data: Parameters<typeof actual.writeFile>[1],
      options?: Parameters<typeof actual.writeFile>[2],
    ) {
      failState.writeFileCalls.push(String(target));
      if (failState.probeWriteEexistNext && isProbe(String(target))) {
        failState.probeWriteEexistNext = false;
        await actual.writeFile(target, 'foreign data', 'utf8');
        throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' }) as NodeJS.ErrnoException;
      }
      return actual.writeFile(target, data, options);
    },
    async rm(target: string, options?: import('node:fs').RmOptions) {
      failState.rmCalls.push(target);
      if (failState.rmFailuresRemaining > 0) {
        failState.rmFailuresRemaining -= 1;
        throw Object.assign(new Error('EBUSY rm'), { code: 'EBUSY' }) as NodeJS.ErrnoException;
      }
      return actual.rm(target, options);
    },
  };
});

import { runAvailabilityJob, runValidateJob, runWriteProbe } from '../workdirProbeHostProcess';

let root = '';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-probe-child-'));
  failState.probeWriteEexistNext = false;
  failState.rmFailuresRemaining = 0;
  failState.writeFileCalls.length = 0;
  failState.rmCalls.length = 0;
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('validate job(realpath → stat → wx 探针 → 清理)', () => {
  it('可写目录回传解析后的真实路径且不留探针残留', async () => {
    const dir = path.join(root, 'project');
    fs.mkdirSync(dir);
    await expect(runValidateJob(dir)).resolves.toEqual({ ok: true, realPath: dir });
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('文件与不存在的路径分别收口为 NOT_DIRECTORY 与原生码', async () => {
    const file = path.join(root, 'now-a-file');
    fs.writeFileSync(file, 'x');
    await expect(runValidateJob(file)).resolves.toEqual({ ok: false, code: 'NOT_DIRECTORY' });
    const missing = await runValidateJob(path.join(root, 'missing'));
    expect(missing).toEqual({ ok: false, code: 'ENOENT' });
  });

  it('写探针独占碰撞(EEXIST)收口为 NOT_WRITABLE, 碰撞文件原样保留', async () => {
    const dir = path.join(root, 'project');
    fs.mkdirSync(dir);
    failState.probeWriteEexistNext = true;
    await expect(runValidateJob(dir)).resolves.toEqual({ ok: false, code: 'NOT_WRITABLE' });
    const collided = failState.writeFileCalls.find((c) => c.includes('.cindy-workdir-probe-'))!;
    expect(fs.readFileSync(collided, 'utf8')).toBe('foreign data');
    expect(failState.rmCalls).toEqual([]);
  });
});

describe('availability job(stat → wx 探针 → 清理)', () => {
  it('可写目录 usable, 文件 NOT_DIRECTORY, rm 失败接受残留', async () => {
    const dir = path.join(root, 'avail');
    fs.mkdirSync(dir);
    await expect(runAvailabilityJob(dir)).resolves.toEqual({ ok: true, usable: true });

    const file = path.join(root, 'now-a-file');
    fs.writeFileSync(file, 'x');
    await expect(runAvailabilityJob(file)).resolves.toEqual({ ok: false, code: 'NOT_DIRECTORY' });

    failState.rmFailuresRemaining = 1;
    await expect(runAvailabilityJob(dir)).resolves.toEqual({ ok: true, usable: true });
    const residue = fs
      .readdirSync(dir)
      .find((n) => n.startsWith('.cindy-workdir-probe-'))!;
    expect(residue).toBeTruthy(); // 0 字节残留, 不重试不扫描
  });

  it('runWriteProbe 只删除本次确认创建的探针, 用户同前缀文件不触碰', async () => {
    const dir = path.join(root, 'discipline');
    fs.mkdirSync(dir);
    const userNote = path.join(dir, '.cindy-workdir-probe-user-note');
    fs.writeFileSync(userNote, 'user data');

    expect(await runWriteProbe(dir)).toBe(true);
    expect(fs.readFileSync(userNote, 'utf8')).toBe('user data');
    expect(fs.readdirSync(dir)).toEqual(['.cindy-workdir-probe-user-note']);
  });
});
