/**
 * RemoteFileBrowserManager 状态机单测:依赖全 fake(内存 stream 直连真
 * runFileService),覆盖——
 *   1. 懒建 + 并发去重(两次并发请求只建一条链)
 *   2. 未安装 → install → 成功
 *   3. schema 过期 → 重推 → 成功
 *   4. node 缺失 → NODE_MISSING 错误
 *   5. 断链 → 自动重建一次
 */

import { PassThrough } from 'node:stream';
import { mkdtemp, rm, writeFile as fsWriteFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runFileService } from '@cindy/remote-file-service';
import { FILE_SERVICE_BUNDLE_VERSION, FILE_SERVICE_SCHEMA_VERSION } from '@cindy/remote-file-service/protocol';
import type { FileServiceStream } from '@cindy/remote-file-service/client';

import { RemoteFileBrowserManager, type RemoteFsDeps, type RemoteFsProbe } from '../remote.js';

vi.mock('electron', () => ({
  app: { getAppPath: () => '/tmp' },
}));

const silent = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
};

/** 每次 execStream 起一个真的 in-process file-service,返回 client 侧 stream。 */
function makeFakeExecStream(onSpawn?: () => void) {
  const alive: PassThrough[] = [];
  const execStream = async (): Promise<FileServiceStream> => {
    onSpawn?.();
    const toServer = new PassThrough();
    const fromServer = new PassThrough();
    alive.push(toServer, fromServer);
    void runFileService(toServer, fromServer, { logger: silent });
    return {
      write: (data) => void toServer.write(data),
      onStdout: (cb) => {
        const h = (c: Buffer | string): void => cb(typeof c === 'string' ? c : c.toString('utf8'));
        fromServer.on('data', h);
        return () => fromServer.off('data', h);
      },
      onStderr: () => () => {},
      onClose: (cb) => {
        const h = (): void => cb({ code: 0, signal: null });
        fromServer.on('end', h);
        return () => fromServer.off('end', h);
      },
      onError: () => () => {},
      kill: () => {
        toServer.end();
        fromServer.end();
      },
    };
  };
  return { execStream, alive };
}

function makeDeps(overrides: {
  probeResults: RemoteFsProbe[];
  installResult?: { ready: boolean; error?: string };
  onSpawn?: () => void;
}): { deps: RemoteFsDeps; calls: { ensure: number; probe: number; install: number; spawn: number } } {
  const calls = { ensure: 0, probe: 0, install: 0, spawn: 0 };
  const { execStream } = makeFakeExecStream(() => {
    calls.spawn += 1;
    overrides.onSpawn?.();
  });
  const probeQueue = [...overrides.probeResults];
  const deps: RemoteFsDeps = {
    ensureHostReady: async () => {
      calls.ensure += 1;
    },
    getHost: () => ({ execStream }),
    probe: async () => {
      calls.probe += 1;
      // 队列耗尽后重复最后一个(安装后复 probe 的常见形态)。
      return probeQueue.length > 1 ? probeQueue.shift()! : probeQueue[0]!;
    },
    install: async () => {
      calls.install += 1;
      return overrides.installResult ?? { ready: true };
    },
    logger: silent,
  };
  return { deps, calls };
}

const READY_PROBE: RemoteFsProbe = {
  nodeReady: true,
  installed: true,
  schemaVersion: FILE_SERVICE_SCHEMA_VERSION,
  bundleVersion: FILE_SERVICE_BUNDLE_VERSION,
  binaryPath: '/remote/file-service.mjs',
  nodeBinaryPath: '/remote/node',
  rgPath: null,
};

describe('RemoteFileBrowserManager', () => {
  let workdir: string;

  beforeEach(async () => {
    workdir = await mkdtemp(path.join(os.tmpdir(), 'rfb-mgr-'));
    await fsWriteFile(path.join(workdir, 'hello.txt'), 'hi\n', 'utf8');
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  it('already-installed host: no install, requests served', async () => {
    const { deps, calls } = makeDeps({ probeResults: [READY_PROBE] });
    const mgr = new RemoteFileBrowserManager(deps);
    const { entries } = await mgr.request('h1', 'listDir', { workdir });
    expect(entries.map((e) => e.name)).toContain('hello.txt');
    expect(calls.install).toBe(0);
    expect(calls.spawn).toBe(1);
    await mgr.disposeAll();
  });

  it('concurrent first requests share one connection build', async () => {
    const { deps, calls } = makeDeps({ probeResults: [READY_PROBE] });
    const mgr = new RemoteFileBrowserManager(deps);
    const [a, b] = await Promise.all([
      mgr.request('h1', 'stat', { workdir, relPath: 'hello.txt' }),
      mgr.request('h1', 'readFile', { workdir, relPath: 'hello.txt' }),
    ]);
    expect(a.type).toBe('file');
    expect(b.content).toBe('hi\n');
    expect(calls.spawn).toBe(1);
    expect(calls.ensure).toBe(1);
    await mgr.disposeAll();
  });

  it('not-installed → installs then serves', async () => {
    const { deps, calls } = makeDeps({
      probeResults: [
        { ...READY_PROBE, installed: false, schemaVersion: null },
        READY_PROBE,
      ],
    });
    const mgr = new RemoteFileBrowserManager(deps);
    const { entries } = await mgr.request('h1', 'listDir', { workdir });
    expect(entries.length).toBeGreaterThan(0);
    expect(calls.install).toBe(1);
    await mgr.disposeAll();
  });

  it('stale schema → reinstalls then serves', async () => {
    const { deps, calls } = makeDeps({
      probeResults: [
        { ...READY_PROBE, schemaVersion: FILE_SERVICE_SCHEMA_VERSION - 1 },
        READY_PROBE,
      ],
    });
    const mgr = new RemoteFileBrowserManager(deps);
    await mgr.request('h1', 'stat', { workdir, relPath: 'hello.txt' });
    expect(calls.install).toBe(1);
    await mgr.disposeAll();
  });

  it('stale bundle (schema compatible) → reinstalls then serves', async () => {
    // schema 相等但 bundle 落后:daemon 行为修复只 bump bundle 版本,必须触发重推。
    const { deps, calls } = makeDeps({
      probeResults: [
        { ...READY_PROBE, bundleVersion: '0.0.0-stale' },
        READY_PROBE,
      ],
    });
    const mgr = new RemoteFileBrowserManager(deps);
    await mgr.request('h1', 'stat', { workdir, relPath: 'hello.txt' });
    expect(calls.install).toBe(1);
    await mgr.disposeAll();
  });

  it('node missing → NODE_MISSING error, nothing spawned', async () => {
    const { deps, calls } = makeDeps({
      probeResults: [{ ...READY_PROBE, nodeReady: false, installed: false, schemaVersion: null }],
    });
    const mgr = new RemoteFileBrowserManager(deps);
    await expect(mgr.request('h1', 'listDir', { workdir })).rejects.toMatchObject({
      code: 'NODE_MISSING',
    });
    expect(calls.spawn).toBe(0);
    expect(calls.install).toBe(0);
  });

  it('install failure surfaces INSTALL_FAILED', async () => {
    const { deps } = makeDeps({
      probeResults: [{ ...READY_PROBE, installed: false, schemaVersion: null }],
      installResult: { ready: false, error: 'upload exploded' },
    });
    const mgr = new RemoteFileBrowserManager(deps);
    await expect(mgr.request('h1', 'listDir', { workdir })).rejects.toMatchObject({
      code: 'INSTALL_FAILED',
    });
  });

  it('channel loss → rebuilds once and retries the request', async () => {
    const { deps, calls } = makeDeps({ probeResults: [READY_PROBE] });
    const mgr = new RemoteFileBrowserManager(deps);
    await mgr.request('h1', 'stat', { workdir, relPath: 'hello.txt' });
    expect(calls.spawn).toBe(1);
    // 模拟断链:dispose 当前 host 的 client(等价 daemon 进程死掉)。
    await mgr.disposeHost('h1');
    const { entries } = await mgr.request('h1', 'listDir', { workdir });
    expect(entries.map((e) => e.name)).toContain('hello.txt');
    expect(calls.spawn).toBe(2);
    await mgr.disposeAll();
  });

  it('endpoint invalidation fences an in-flight build before it can spawn the old host', async () => {
    let releaseEnsure!: () => void;
    const { deps, calls } = makeDeps({ probeResults: [READY_PROBE] });
    deps.ensureHostReady = () => new Promise<void>((resolve) => {
      releaseEnsure = resolve;
    });
    const mgr = new RemoteFileBrowserManager(deps);
    const request = mgr.request('h1', 'listDir', { workdir });

    await mgr.disposeHost('h1');
    releaseEnsure();

    await expect(request).rejects.toMatchObject({ code: 'ENDPOINT_STALE' });
    expect(calls.spawn).toBe(0);
  });
});
