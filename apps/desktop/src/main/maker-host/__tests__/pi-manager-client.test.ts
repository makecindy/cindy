/**
 * Tests for pi-manager-client.ts — the desktop-side wrapper around the remote
 * pi-manager daemon (probe + install + ensure + RPC bridge).
 *
 * These tests verify the post-python-daemon-retirement behavior:
 *   - ensurePiManagerInstalled is the ONLY preflight path (no python daemon fallback)
 *   - piManagerKill goes through withPiManagerRpc exclusively (no python daemon kill)
 *   - piManagerList goes through withPiManagerRpc exclusively (no python daemon list)
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — pi-manager-client imports from @cindy/maker-remote-ssh, electron,
// and node:fs. We stub the remote install layer so we only test the
// desktop-side orchestration.
// ---------------------------------------------------------------------------

const {
  mockProbePiManager,
  mockInstallPiManagerBundle,
  mockEnsurePiManagerDaemon,
  mockStatSync,
  realShellQuoteRef,
} = vi.hoisted(() => ({
  mockProbePiManager: vi.fn(),
  mockInstallPiManagerBundle: vi.fn(),
  mockEnsurePiManagerDaemon: vi.fn(),
  mockStatSync: vi.fn(),
  realShellQuoteRef: { fn: null as null | ((s: string) => string) },
}));

vi.mock('electron', () => ({
  app: {
    getAppPath: () => '/fake/test/app',
    getPath: () => '/fake/test/userData',
  },
  BrowserWindow: {
    getAllWindows: () => [],
  },
}));

vi.mock('@cindy/maker-remote-ssh', () => ({
  probePiManager: mockProbePiManager,
  installPiManagerBundle: mockInstallPiManagerBundle,
  ensurePiManagerDaemon: mockEnsurePiManagerDaemon,
  shellQuote: (s: string) => realShellQuoteRef.fn!(s),
  // 轮 22:pi 独立化 —— node 自动安装脚本与版本(测试只断言脚本被 exec)。
  BUNDLED_NODE_INSTALL_SH: 'NODE_INSTALL_START ${NODE_VER}\nNODE_INSTALL_DONE 22.13.0\n',
  BUNDLED_NODE_VERSION: '22.13.0',
}));

import { shellQuote as realShellQuote } from '../pi-remote-transport.js';
realShellQuoteRef.fn = realShellQuote;

// 轮 7 CRITICAL #1:mock 只覆盖需要替换的部分, PROTOCOL_VERSION 等常量从
// 实际模块展开 —— 否则 ensurePiManagerInstalled 的协议检查(退役审轮 10 加的)
// 会因 PROTOCOL_VERSION 缺失而运行时报错。
vi.mock('@cindy/maker-pi-manager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cindy/maker-pi-manager')>();
  return {
    ...actual,
    RpcClient: vi.fn(),
    PI_MANAGER_BUNDLE_VERSION: '0.1.0',
    METHODS: {
      PROTOCOL_HELLO: 'protocol/hello',
      PI_ENSURE: 'pi/ensure',
      PI_KILL: 'pi/kill',
      PI_LIST: 'pi/list',
      PI_SHUTDOWN: 'pi/shutdown',
    },
  };
});

// electron stub: app.getAppPath() → cwd, so resolvePiManagerBundlePath won't
// find the bundle unless we point it at a real path.  We mock fs.statSync
// to control which candidates succeed.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    statSync: mockStatSync,
    default: { ...actual, statSync: mockStatSync },
  };
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

import type { RemoteHost } from '@cindy/maker-remote-ssh';

function makeHost(id: string): RemoteHost {
  // exec 默认返回 NO_DAEMON(杀 daemon 脚本的兜底输出) —— 轮 13 HIGH-1 修复后
  // 版本差路径会触发 killRemotePiManagerDaemon 的 host.exec。
  return {
    id,
    exec: vi.fn(async () => ({ exitCode: 0, stdout: 'NO_DAEMON', stderr: '' })),
  } as unknown as RemoteHost;
}

interface Logger {
  debug(msg: string, ctx?: Record<string, unknown>): void;
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

function makeLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => makeLogger()),
  };
}

const FULL_PROBE = {
  nodeReady: true,
  piManagerInstalled: true,
  piManagerVersion: '0.1.0',
  piManagerProtocolVersion: 1,
  installDir: '/home/u/.xdt-server/v1',
  nodeBinaryPath: '/home/u/.xdt-server/v1/node/bin/node',
  piManagerBinaryPath: '/home/u/.xdt-server/v1/pi-manager/pi-manager.mjs',
  piManagerSockPath: '/home/u/.xdt-server/v1/pi-manager/pi-manager.sock',
};

const PROBE_NO_NODE = { ...FULL_PROBE, nodeReady: false };
const PROBE_NO_MGR = { ...FULL_PROBE, piManagerInstalled: false, piManagerVersion: null, piManagerProtocolVersion: null };
const PROBE_STALE_VERSION = { ...FULL_PROBE, piManagerVersion: '0.0.9' };
// 轮 14 GAP-5:版本匹配但协议不兼容(bundle 版本同号、protocolVersion 漂移)。
const PROBE_INCOMPATIBLE_PROTOCOL = { ...FULL_PROBE, piManagerProtocolVersion: 999 };

// ---------------------------------------------------------------------------
// ensurePiManagerInstalled
// ---------------------------------------------------------------------------

import { ensurePiManagerInstalled } from '../pi-manager-client.js';

describe('ensurePiManagerInstalled (post-retirement: pi-manager only)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStatSync.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
  });

  it('auto-installs bundled node when missing (round 22: pi independent, no CC/CX dependency)', async () => {
    // 第一次 probe:node 缺失 → 自动装 node → 二次 probe:node 就绪 + pi-manager
    // 也未装 → 装 bundle → ensure daemon。全程不依赖 CC/CX 安装链。
    mockProbePiManager
      .mockResolvedValueOnce(PROBE_NO_NODE) // 首次:node 缺失
      .mockResolvedValueOnce(PROBE_NO_MGR); // 二次:node 就绪, mgr 未装
    mockInstallPiManagerBundle.mockResolvedValue({ ready: true });
    mockStatSync.mockImplementation((p: string) => {
      if (p.includes('maker-pi-manager') && p.endsWith('.mjs')) {
        return { isFile: () => true, size: 1024 };
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const host = {
      id: 'h1',
      exec: vi.fn(async () => ({ exitCode: 0, stdout: 'NODE_INSTALL_DONE 22.13.0\n', stderr: '' })),
    } as unknown as RemoteHost;
    const logger = makeLogger();

    await ensurePiManagerInstalled(host, logger);

    // 自动装 node:exec 被调用且脚本来自 BUNDLED_NODE_INSTALL_SH
    expect(host.exec).toHaveBeenCalledWith(
      expect.stringContaining('NODE_INSTALL_START'),
      expect.objectContaining({ label: 'pi-manager-node-install' }),
    );
    // 之后正常走 install + ensure daemon(不再抛「先装 CC/CX」)
    expect(mockProbePiManager).toHaveBeenCalledTimes(2);
    expect(mockInstallPiManagerBundle).toHaveBeenCalled();
    expect(mockEnsurePiManagerDaemon).toHaveBeenCalledWith(host, expect.objectContaining({ protocolVersion: 1 }));
  });

  it('throws when node auto-install fails (still no python fallback)', async () => {
    mockProbePiManager.mockResolvedValue(PROBE_NO_NODE);
    const host = {
      id: 'h1',
      exec: vi.fn(async () => ({ exitCode: 7, stdout: '', stderr: 'download failed' })),
    } as unknown as RemoteHost;
    const logger = makeLogger();

    await expect(ensurePiManagerInstalled(host, logger)).rejects.toThrow(/Node\.js install failed/);
    expect(mockInstallPiManagerBundle).not.toHaveBeenCalled();
    expect(mockEnsurePiManagerDaemon).not.toHaveBeenCalled();
  });

  it('fast path: skips install when version matches (pi-manager already up to date)', async () => {
    mockProbePiManager.mockResolvedValue(FULL_PROBE);
    const host = makeHost('h2');
    const logger = makeLogger();

    await ensurePiManagerInstalled(host, logger);

    expect(mockProbePiManager).toHaveBeenCalledWith(host);
    expect(mockInstallPiManagerBundle).not.toHaveBeenCalled();
    expect(mockEnsurePiManagerDaemon).toHaveBeenCalledWith(host, expect.objectContaining({ protocolVersion: 1 }));
    // Logged the skip
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('already installed and up to date'),
      expect.anything(),
    );
  });

  it('installs when pi-manager is not installed (no python daemon fallback)', async () => {
    mockProbePiManager.mockResolvedValue(PROBE_NO_MGR);
    mockInstallPiManagerBundle.mockResolvedValue({ ready: true });
    mockStatSync.mockImplementation((p: string) => {
      // fake the bundle file exists for resolvePiManagerBundlePath
      if (p.includes('maker-pi-manager') && p.endsWith('.mjs')) {
        return { isFile: () => true, size: 1024 };
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const host = makeHost('h3');
    const logger = makeLogger();

    await ensurePiManagerInstalled(host, logger);

    expect(mockProbePiManager).toHaveBeenCalledWith(host);
    expect(mockInstallPiManagerBundle).toHaveBeenCalled();
    expect(mockEnsurePiManagerDaemon).toHaveBeenCalledWith(host, expect.objectContaining({ protocolVersion: 1 }));
  });

  it('version stale + daemon dead → silently upgrades disk bundle (no force kill needed, round 22)', async () => {
    mockProbePiManager.mockResolvedValue(PROBE_STALE_VERSION); // 0.0.9 != 0.1.x
    mockInstallPiManagerBundle.mockResolvedValue({ ready: true });
    mockStatSync.mockImplementation((p: string) => {
      if (p.includes('maker-pi-manager') && p.endsWith('.mjs')) {
        return { isFile: () => true, size: 1024 };
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const host = {
      id: 'h4',
      exec: vi.fn(async (cmd: string, opts?: { label?: string }) => {
        // daemon-alive-check 返回 DEAD(daemon 没在跑)
        if (opts?.label === 'pi-manager-daemon-alive-check') {
          return { exitCode: 0, stdout: 'DEAD\n', stderr: '' };
        }
        return { exitCode: 0, stdout: 'NO_DAEMON', stderr: '' };
      }),
    } as unknown as RemoteHost;
    const logger = makeLogger();

    await ensurePiManagerInstalled(host, logger);

    // daemon 死 → 升级磁盘 bundle(不 kill —— 没有活 daemon 可 kill)
    expect(host.exec).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ label: 'pi-manager-daemon-force-kill' }),
    );
    expect(mockInstallPiManagerBundle).toHaveBeenCalled();
    expect(mockEnsurePiManagerDaemon).toHaveBeenCalledWith(host, expect.objectContaining({ protocolVersion: 1 }));
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('no live daemon'),
      expect.anything(),
    );
  });

  it('version stale + daemon alive → defers upgrade (does NOT kill alive daemon, round 22)', async () => {
    mockProbePiManager.mockResolvedValue(PROBE_STALE_VERSION);
    mockInstallPiManagerBundle.mockResolvedValue({ ready: true });
    mockStatSync.mockImplementation((p: string) => {
      if (p.includes('maker-pi-manager') && p.endsWith('.mjs')) {
        return { isFile: () => true, size: 1024 };
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const host = {
      id: 'h4',
      exec: vi.fn(async (cmd: string, opts?: { label?: string }) => {
        // daemon-alive-check 返回 ALIVE(daemon 正在跑)
        if (opts?.label === 'pi-manager-daemon-alive-check') {
          return { exitCode: 0, stdout: 'ALIVE\n', stderr: '' };
        }
        return { exitCode: 0, stdout: 'NO_DAEMON', stderr: '' };
      }),
    } as unknown as RemoteHost;
    const logger = makeLogger();

    await ensurePiManagerInstalled(host, logger);

    // daemon 活 → 跳过升级(不 install、不 kill), 但仍走 ensurePiManagerDaemon
    // 的在线校验(socket + protocol hello) —— 伪 ALIVE(退出窗口/pid reuse)
    // 在那里被判定 DEAD → 重新 spawn 恢复(轮 22-Z1 HIGH)。
    expect(mockInstallPiManagerBundle).not.toHaveBeenCalled();
    expect(mockEnsurePiManagerDaemon).toHaveBeenCalledWith(host, expect.objectContaining({ protocolVersion: 1 }));
    expect(host.exec).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ label: 'pi-manager-daemon-force-kill' }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('deferring bundle upgrade'),
      expect.anything(),
    );
  });

  it('stale pidfile PID reused by another install-root daemon → NOT alive → upgrades (round 42 P2)', async () => {
    // 轮 42 P2(codex-connector):stale pidfile 的 PID 被复用成**别的** install
    // root 的 pi-manager daemon 时, 只 grep 进程名会误判 ALIVE → defer 升级,
    // 兼容性修复永远到不了该 host。身份校验匹配本 install 的 `--socket` 后
    // 判定 DEAD → 走升级 + spawn 自愈。
    mockProbePiManager.mockResolvedValue(PROBE_STALE_VERSION);
    mockInstallPiManagerBundle.mockResolvedValue({ ready: true });
    mockStatSync.mockImplementation((p: string) => {
      if (p.includes('maker-pi-manager') && p.endsWith('.mjs')) {
        return { isFile: () => true, size: 1024 };
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const host = {
      id: 'h4',
      exec: vi.fn(async (cmd: string, opts?: { label?: string }) => {
        // alive-check 命令里包含 --socket 校验; 这里的 cmd 本身就是我们发的,
        // 测试只需按 label 返回 DEAD(命令里 grep --socket 会失败 → DEAD)。
        if (opts?.label === 'pi-manager-daemon-alive-check') {
          return { exitCode: 0, stdout: 'DEAD\n', stderr: '' };
        }
        return { exitCode: 0, stdout: 'NO_DAEMON', stderr: '' };
      }),
    } as unknown as RemoteHost;
    const logger = makeLogger();

    await ensurePiManagerInstalled(host, logger);

    // 不确认活着 → 升级磁盘 bundle(不是 defer)
    expect(mockInstallPiManagerBundle).toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('no live daemon'),
      expect.anything(),
    );
  });

  it('protocol incompatible (version matches but protocol drifted) forces reinstall (round 14 GAP-5)', async () => {
    mockProbePiManager.mockResolvedValue(PROBE_INCOMPATIBLE_PROTOCOL);
    mockInstallPiManagerBundle.mockResolvedValue({ ready: true });
    mockStatSync.mockImplementation((p: string) => {
      if (p.includes('maker-pi-manager') && p.endsWith('.mjs')) {
        return { isFile: () => true, size: 1024 };
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const host = makeHost('h6');
    const logger = makeLogger();

    await ensurePiManagerInstalled(host, logger);

    // 协议不兼容:kill daemon + 强制重装(versionMatch 置 false 走 install)
    expect(host.exec).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ label: 'pi-manager-daemon-force-kill' }),
    );
    expect(mockInstallPiManagerBundle).toHaveBeenCalled();
    expect(mockEnsurePiManagerDaemon).toHaveBeenCalledWith(host, expect.objectContaining({ protocolVersion: 1 }));
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('protocol mismatch'),
      expect.anything(),
    );
  });

  it('deduplicates concurrent ensurePiManagerInstalled for same host (round 12 MEDIUM-3)', async () => {
    // 两个并发调用(preflight + transport 创建)应共享同一个 install promise,
    // 只 probe/install 一次 —— 防并发 cat > 双写 bundle。
    mockProbePiManager.mockResolvedValue(PROBE_NO_MGR);
    mockInstallPiManagerBundle.mockResolvedValue({ ready: true });
    mockStatSync.mockImplementation((p: string) => {
      if (p.includes('maker-pi-manager') && p.endsWith('.mjs')) {
        return { isFile: () => true, size: 1024 };
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const host = makeHost('h7');
    const logger = makeLogger();

    await Promise.all([
      ensurePiManagerInstalled(host, logger),
      ensurePiManagerInstalled(host, logger),
    ]);

    expect(mockProbePiManager).toHaveBeenCalledTimes(1);
    expect(mockInstallPiManagerBundle).toHaveBeenCalledTimes(1);
    expect(mockEnsurePiManagerDaemon).toHaveBeenCalledTimes(1);
  });

  it('version stale + daemon-alive-check fails → falls through to upgrade (STILL_ALIVE only in protocol-mismatch kill, round 22)', async () => {
    // 轮 22:版本差路径不再调 killRemotePiManagerDaemon —— daemon-alive-check
    // 失败(exec 报错)按「不确认活着」处理, fall through 升级磁盘 bundle。
    // STILL_ALIVE 的抛错语义由 killRemotePiManagerDaemon 直接测试覆盖。
    mockProbePiManager.mockResolvedValue(PROBE_STALE_VERSION);
    mockInstallPiManagerBundle.mockResolvedValue({ ready: true });
    mockStatSync.mockImplementation((p: string) => {
      if (p.includes('maker-pi-manager') && p.endsWith('.mjs')) {
        return { isFile: () => true, size: 1024 };
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    const host = makeHost('h8');
    host.exec = vi.fn(async () => ({
      exitCode: 1,
      stdout: 'STILL_ALIVE',
      stderr: 'process in D state',
    })) as never;
    const logger = makeLogger();

    // alive-check 失败(exit 1)→ 按 dead 处理 → install 升级(不抛错)
    await expect(ensurePiManagerInstalled(host, logger)).resolves.toBeUndefined();
    expect(mockInstallPiManagerBundle).toHaveBeenCalled();
  });

  it('throws when installPiManagerBundle returns ready=false', async () => {
    mockProbePiManager.mockResolvedValue(PROBE_NO_MGR);
    mockInstallPiManagerBundle.mockResolvedValue({ ready: false, error: 'upload failed' });
    mockStatSync.mockImplementation((p: string) => {
      if (p.includes('maker-pi-manager') && p.endsWith('.mjs')) {
        return { isFile: () => true, size: 1024 };
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const host = makeHost('h5');
    const logger = makeLogger();

    await expect(ensurePiManagerInstalled(host, logger)).rejects.toThrow(
      'pi-manager install failed',
    );
    expect(mockEnsurePiManagerDaemon).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// killRemotePiManagerDaemon — 身份绑定脚本行为级测试(轮 18-U3 HIGH)
// ---------------------------------------------------------------------------

import { killRemotePiManagerDaemon } from '../pi-manager-client.js';

describe('killRemotePiManagerDaemon (round 18-U3: identity binding)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProbePiManager.mockResolvedValue(PROBE_STALE_VERSION);
  });

  it('kill script binds identity to socket path (grep -Fq -- --socket) and NO_DAEMON does not kill', async () => {
    let killScript = '';
    const host = {
      id: 'h-kill',
      exec: vi.fn(async (cmd: string) => {
        killScript = cmd;
        return { exitCode: 0, stdout: 'NO_DAEMON\n', stderr: '' };
      }),
    } as unknown as RemoteHost;

    // NO_DAEMON(socket 不匹配 / pidfile 陈旧)→ 不抛错、不 kill
    await killRemotePiManagerDaemon(host);
    expect(host.exec).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ label: 'pi-manager-daemon-force-kill' }),
    );
    // 身份绑定:socket path 进 kill 脚本, 且 NO_DAEMON 分支不执行 kill
    expect(killScript).toContain('--socket $MGR_SOCK');
    expect(killScript).toContain('grep -Fq');
    expect(killScript).toContain('NO_DAEMON; exit 0');
    expect(killScript).toContain('kill "$PID" >/dev/null 2>&1 || true');
  });

  it('STILL_ALIVE (exit 1) throws — must not silently continue', async () => {
    const host = {
      id: 'h-kill2',
      exec: vi.fn(async () => ({ exitCode: 1, stdout: 'STILL_ALIVE\n', stderr: '' })),
    } as unknown as RemoteHost;

    await expect(killRemotePiManagerDaemon(host)).rejects.toThrow(/force-kill failed/);
  });
});
