/**
 * 「登出没清干净」的持久重试队列。
 *
 * 隐私承诺是「登出后本机不留上一个账号的远程聊天缓存」;删除可能失败(文件锁 / 权限),
 * 而登出不能因此卡住 —— 所以失败必须留下**可重试的持久痕迹**,而不是一行日志
 * (review: codex P1)。这里守三件事:入队去重与计数、消化后条目消失、
 * 以及队列文件被改写成任意路径时不照着删(它是普通 JSON,不能当授权)。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

let userData: string;

vi.mock('electron', () => ({
  app: { getPath: (name: string) => (name === 'userData' ? userData : userData) },
}));
vi.mock('../../logger', () => ({
  createLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

import {
  drainPurgeQueue,
  enqueuePurge,
  isPurgableRoot,
  __testing,
} from '../mirrorCachePurgeQueue';

function queueFile(): string {
  return path.join(userData, __testing.queueFileName);
}

/** 造一个 owner 作用域下的缓存目录(带内容)。 */
async function makeOwnerCache(ownerKey: string): Promise<string> {
  const root = path.join(userData, 'owners', ownerKey, 'device-link-mirror-cache');
  await fsp.mkdir(path.join(root, 'messages'), { recursive: true });
  await fsp.writeFile(path.join(root, 'messages', 'a.json'), '{}', 'utf8');
  return root;
}

beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-purge-queue-'));
});

afterEach(() => {
  fs.rmSync(userData, { recursive: true, force: true });
});

describe('isPurgableRoot', () => {
  it('只接受 owners/ 之内的路径', () => {
    const owners = '/data/owners';
    expect(isPurgableRoot('/data/owners/abc/device-link-mirror-cache', owners)).toBe(true);
    expect(isPurgableRoot('/data/owners', owners)).toBe(false);
    expect(isPurgableRoot('/data/other/abc', owners)).toBe(false);
    expect(isPurgableRoot('/data/owners/../secrets', owners)).toBe(false);
    expect(isPurgableRoot('', owners)).toBe(false);
  });
});

describe('enqueuePurge / drainPurgeQueue', () => {
  it('入队后消化成功 → 目录被删、队列文件消失', async () => {
    const root = await makeOwnerCache('owner-1');
    await enqueuePurge(root);
    expect(fs.existsSync(queueFile())).toBe(true);

    const result = await drainPurgeQueue();

    expect(result).toEqual({ purged: 1, pending: 0 });
    expect(fs.existsSync(root)).toBe(false);
    expect(fs.existsSync(queueFile())).toBe(false);
  });

  it('同一目录重复入队只保留一条,attempts 累加', async () => {
    const root = await makeOwnerCache('owner-1');
    await enqueuePurge(root);
    await enqueuePurge(root);
    const entries = await __testing.readQueue();
    expect(entries).toHaveLength(1);
    expect(entries[0].attempts).toBe(2);
  });

  it('owners/ 之外的路径拒绝入队(不给自己造一把任意删除的武器)', async () => {
    const outside = path.join(userData, 'not-owners', 'x');
    await fsp.mkdir(outside, { recursive: true });
    await enqueuePurge(outside);
    expect(fs.existsSync(queueFile())).toBe(false);
    expect(fs.existsSync(outside)).toBe(true);
  });

  it('队列文件被改写成 owners 之外的路径 → 消化时丢弃,不照着删', async () => {
    const victim = path.join(userData, 'important');
    await fsp.mkdir(victim, { recursive: true });
    await fsp.writeFile(
      queueFile(),
      JSON.stringify({ version: 1, entries: [{ root: victim, since: 1, attempts: 1 }] }),
      'utf8',
    );

    const result = await drainPurgeQueue();

    expect(result).toEqual({ purged: 0, pending: 0 });
    expect(fs.existsSync(victim)).toBe(true);
    expect(fs.existsSync(queueFile())).toBe(false);
  });

  it('空队列 / 损坏 JSON → 安全返回零,不抛错', async () => {
    expect(await drainPurgeQueue()).toEqual({ purged: 0, pending: 0 });
    await fsp.writeFile(queueFile(), 'not json', 'utf8');
    expect(await drainPurgeQueue()).toEqual({ purged: 0, pending: 0 });
  });

  it('目标已经不存在 → 算清掉(rm force 幂等),条目移除', async () => {
    const root = path.join(userData, 'owners', 'owner-gone', 'device-link-mirror-cache');
    await fsp.mkdir(root, { recursive: true });
    await enqueuePurge(root);
    await fsp.rm(root, { recursive: true, force: true });

    expect(await drainPurgeQueue()).toEqual({ purged: 1, pending: 0 });
    expect(fs.existsSync(queueFile())).toBe(false);
  });
});
