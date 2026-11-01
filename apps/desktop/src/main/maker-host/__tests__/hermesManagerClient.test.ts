/**
 * hermesManagerClient.test.ts — host 侧 hermes-mgr daemon 生命周期。
 *
 * 保护契约:
 *  - HERMES_HOME 默认 ~/.hermes-cindy, 拒绝 ~/.hermes 及其子路径(含大小写折叠);
 *  - ensure 对 live daemon 只 probe + hello, 不 fork, 成功后缓存 socket;
 *  - dead daemon → app-owned utilityProcess.fork(argv/env 正确), 无法 READY 时
 *    typed failure(带 bounded stderr tail), 不缓存;
 *  - 协议不兼容 → 恰好 respawn 一次, 失败带明确升级错误;
 *  - 并发 ensure 共享同一个 in-flight; stop 与 ensure 竞争时 kill child 且不缓存。
 *
 * 真实 daemon 不在单测里运行; fake daemon 是 tmpdir 里的真实 net.Server, 按
 * wire 回答 protocol/hello。fork 永远注入 fake。
 */

import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { PROTOCOL_VERSION } from '@cindy/maker-hermes-manager';

const hoisted = vi.hoisted(() => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// 生产 logger 会写 userData 日志文件; 单测只需要吞掉输出。
vi.mock('../../logger.js', () => ({
  createLogger: () => hoisted.logger,
  getLogLevel: () => 'info',
}));

import {
  ensureHermesManagerDaemon,
  hermesManagerSocketPath,
  parseHermesPluginLists,
  resetHermesManagerClientForTests,
  resolveHermesHome,
  stopHermesManagerDaemon,
  type HermesManagerFork,
} from '../hermes-manager-client.js';

let rootDir: string;
const servers: net.Server[] = [];
const HERMES_ENV_KEYS = [
  'HERMES_HOME',
  'CINDY_TEST_SECRET',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'https_proxy',
  'http_proxy',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
] as const;

beforeEach(() => {
  rootDir = mkdtempSync(path.join(os.tmpdir(), 'cindy-hermes-mgr-client-'));
  resetHermesManagerClientForTests();
  for (const key of HERMES_ENV_KEYS) delete process.env[key];
});

/** Windows named pipes live outside the filesystem; tests need a real pipe name there. */
function daemonSocketPath(): string {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\cindy-hermes-mgr-test-${path.basename(rootDir)}`;
  }
  return path.join(rootDir, 'mgr.sock');
}

afterEach(async () => {
  resetHermesManagerClientForTests();
  await Promise.all(
    servers.splice(0).map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
  rmSync(rootDir, { recursive: true, force: true });
  for (const key of HERMES_ENV_KEYS) delete process.env[key];
  vi.clearAllMocks();
});

describe('resolveHermesHome', () => {
  it('defaults to ~/.hermes-cindy and refuses the daily Hermes home or anything inside it', () => {
    expect(resolveHermesHome()).toBe(path.join(os.homedir(), '.hermes-cindy'));

    process.env.HERMES_HOME = path.join(os.homedir(), '.hermes');
    expect(() => resolveHermesHome()).toThrow(/daily Hermes home/);

    // 尾部分隔符在 path.resolve 后仍归一到同一路径, 同样拒绝。
    process.env.HERMES_HOME = `${path.join(os.homedir(), '.hermes')}${path.sep}`;
    expect(() => resolveHermesHome()).toThrow(/daily Hermes home/);

    // 日常 home 的子路径同样会写入用户的 Hermes 数据, 拒绝。
    process.env.HERMES_HOME = path.join(os.homedir(), '.hermes', 'nested');
    expect(() => resolveHermesHome()).toThrow(/daily Hermes home/);

    if (process.platform === 'darwin' || process.platform === 'win32') {
      // 这两类文件系统通常大小写不敏感, 大小写变体仍是同一个日常 home。
      process.env.HERMES_HOME = path.join(os.homedir(), '.HERMES');
      expect(() => resolveHermesHome()).toThrow(/daily Hermes home/);
    }
  });
});

describe('hermes manager daemon lifecycle', () => {
  it('reports no socket before a successful ensure', () => {
    expect(hermesManagerSocketPath()).toBeUndefined();
  });

  it('reuses a live daemon, caches its socket, and never forks', async () => {
    const socketPath = daemonSocketPath();
    await startFakeDaemon(socketPath);
    const forkOverride = vi.fn<HermesManagerFork>();

    const result = await ensureHermesManagerDaemon({
      socketPathOverride: socketPath,
      forkOverride,
      probeTimeoutMs: 300,
      readyTimeoutMs: 300,
    });

    expect(result).toEqual({ ok: true, socketPath });
    expect(forkOverride).not.toHaveBeenCalled();
    expect(hermesManagerSocketPath()).toBe(socketPath);
  });

  it('forks the bundle as an app-owned utility process and fails typed without READY', async () => {
    const socketPath = daemonSocketPath();
    const home = path.join(rootDir, 'hermes-home');
    const bundlePath = path.join(rootDir, 'hermes-mgr.mjs');
    process.env.HERMES_HOME = home;
    process.env.CINDY_TEST_SECRET = 'must-not-leak';
    process.env.HTTPS_PROXY = 'http://proxy.local:8443';
    process.env.https_proxy = 'http://proxy.local:8443';
    process.env.NODE_EXTRA_CA_CERTS = path.join(rootDir, 'ca.pem');
    process.env.XDG_CONFIG_HOME = path.join(rootDir, 'xdg-config');
    const fake = makeFakeUtilityProcess();
    const forkOverride = vi.fn<HermesManagerFork>(() => fake.child);

    const result = await ensureHermesManagerDaemon({
      socketPathOverride: socketPath,
      forkOverride,
      bundlePathOverride: bundlePath,
      probeTimeoutMs: 80,
      readyTimeoutMs: 40,
    });

    expect(forkOverride).toHaveBeenCalledTimes(1);
    const [modulePath, args, options] = forkOverride.mock.calls[0]!;
    expect(modulePath).toBe(bundlePath);
    expect(args).toEqual(['--socket', socketPath, '--hermes-home', home, '--per-session-homes']);
    expect(options).toMatchObject({
      cwd: os.tmpdir(),
      stdio: ['ignore', 'pipe', 'pipe'],
      serviceName: 'cindy-hermes-mgr',
    });
    // utilityProcess 不需要 RunAsNode; 也不能把宿主凭证环境整包透传给 daemon。
    const env = options!.env as Record<string, string | undefined>;
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(env.CINDY_TEST_SECRET).toBeUndefined();
    if (process.env.PATH !== undefined) expect(env.PATH).toBe(process.env.PATH);
    if (process.env.HOME !== undefined) expect(env.HOME).toBe(process.env.HOME);
    // 代理 / TLS / XDG 配置必须透传: daemon spawn 的 Hermes CLI 继承这份 env。
    expect(env.HTTPS_PROXY).toBe('http://proxy.local:8443');
    expect(env.https_proxy).toBe('http://proxy.local:8443');
    expect(env.NODE_EXTRA_CA_CERTS).toBe(path.join(rootDir, 'ca.pem'));
    expect(env.XDG_CONFIG_HOME).toBe(path.join(rootDir, 'xdg-config'));
    // 未设置的变量不凭空出现。
    expect(env.NO_PROXY).toBeUndefined();
    expect(env.SSL_CERT_FILE).toBeUndefined();
    expect(env.XDG_CACHE_HOME).toBeUndefined();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('failed to start');
      expect(result.message).toContain('no READY line');
    }
    expect(fake.kill).toHaveBeenCalled();
    expect(hermesManagerSocketPath()).toBeUndefined();
  });

  it('respawns exactly once on protocol mismatch, then fails with the upgrade error', async () => {
    const socketPath = daemonSocketPath();
    await startFakeDaemon(socketPath, 2);
    const fake = makeFakeUtilityProcess();
    const forkOverride = vi.fn<HermesManagerFork>(() => fake.child);

    const result = await ensureHermesManagerDaemon({
      socketPathOverride: socketPath,
      forkOverride,
      bundlePathOverride: path.join(rootDir, 'hermes-mgr.mjs'),
      probeTimeoutMs: 80,
      readyTimeoutMs: 40,
    });

    expect(forkOverride).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('protocol upgrade required');
      expect(result.message).toContain('daemon speaks v2');
      expect(result.message).toContain(`this app expects v${PROTOCOL_VERSION}`);
      expect(result.message).toContain('rebuild/repackage');
    }
    expect(hermesManagerSocketPath()).toBeUndefined();
  });

  it('shares one in-flight ensure across concurrent callers', async () => {
    const socketPath = daemonSocketPath();
    const fake = makeFakeUtilityProcess();
    const forkOverride = vi.fn<HermesManagerFork>(() => fake.child);
    const options = {
      socketPathOverride: socketPath,
      forkOverride,
      bundlePathOverride: path.join(rootDir, 'hermes-mgr.mjs'),
      probeTimeoutMs: 80,
      readyTimeoutMs: 40,
    } as const;

    const [first, second] = await Promise.all([
      ensureHermesManagerDaemon(options),
      ensureHermesManagerDaemon(options),
    ]);

    expect(forkOverride).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it('stop during ensure kills the child and leaves no cached socket', async () => {
    const socketPath = daemonSocketPath();
    const fake = makeFakeUtilityProcess();
    let signalForked!: () => void;
    const forked = new Promise<void>((resolve) => {
      signalForked = resolve;
    });
    const forkOverride = vi.fn<HermesManagerFork>(() => {
      signalForked();
      return fake.child;
    });

    const ensurePromise = ensureHermesManagerDaemon({
      socketPathOverride: socketPath,
      forkOverride,
      bundlePathOverride: path.join(rootDir, 'hermes-mgr.mjs'),
      probeTimeoutMs: 80,
      // stop 会 kill child; 这个上限只是防测试挂死的保险。
      readyTimeoutMs: 5_000,
    });
    await forked;
    const stopPromise = stopHermesManagerDaemon();
    const [result] = await Promise.all([ensurePromise, stopPromise]);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('stop requested');
    expect(fake.kill).toHaveBeenCalled();
    expect(hermesManagerSocketPath()).toBeUndefined();
  });
});

/* ============================== helpers ============================== */

function startFakeDaemon(socketPath: string, protocolVersion = 1): Promise<net.Server> {
  const server = net.createServer((socket) => {
    let buffered = '';
    socket.on('data', (chunk: Buffer) => {
      buffered += chunk.toString('utf8');
      let newline = buffered.indexOf('\n');
      while (newline >= 0) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf('\n');
        if (!line) continue;
        const message = JSON.parse(line) as {
          type?: string;
          id?: number;
          method?: string;
        };
        if (message.type === 'request' && message.method === 'protocol/hello') {
          socket.write(
            `${JSON.stringify({ type: 'response', id: message.id, result: { protocolVersion } })}\n`,
          );
        }
      }
    });
    socket.on('error', () => undefined);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      servers.push(server);
      resolve(server);
    });
  });
}

function makeFakeUtilityProcess(): {
  child: ReturnType<HermesManagerFork>;
  kill: Mock;
  stderr: PassThrough;
} {
  const stderr = new PassThrough();
  const fake = new EventEmitter() as EventEmitter & Record<string, unknown>;
  let exited = false;
  const kill = vi.fn(() => {
    if (!exited) {
      exited = true;
      fake.emit('exit', 0);
    }
    return true;
  });
  Object.assign(fake, { pid: 424242, stderr, stdout: new PassThrough(), kill });
  return { child: fake as unknown as ReturnType<HermesManagerFork>, kill, stderr };
}

describe('parseHermesPluginLists (ROADMAP 1.6)', () => {
  it('reads the shape Hermes writes after `plugins disable` (inline [] + block list)', () => {
    // Owner's ~/.hermes-cindy/config.yaml after `hermes-cindy plugins disable superpowers`, 2026-11-01.
    const lists = parseHermesPluginLists(
      'model:\n  default: x\nplugins:\n  enabled: []\n  disabled:\n    - superpowers/.hermes-plugin\n\nmcp_servers: {}\n',
    );
    expect([...lists.enabled]).toEqual([]);
    expect([...lists.disabled]).toEqual(['superpowers']);
  });

  it('reads an enabled block list and tolerates missing or broken config', () => {
    expect([...parseHermesPluginLists('plugins:\n  enabled:\n    - superpowers/.hermes-plugin\n    - other\n').enabled])
      .toEqual(['superpowers', 'other']);
    expect(parseHermesPluginLists('model: {}\n').enabled.size).toBe(0);
    expect(parseHermesPluginLists('plugins: [\n').enabled.size).toBe(0);
  });
});
