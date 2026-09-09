/**
 * agent-proxy 策略层单测 (固定端口 + 双模式版)。
 *
 * 覆盖:
 *   - buildAgentProxyEnv / buildAgentProxyEnvUppercase / buildAgentProxyMarkerContent
 *     的内容契约 (env 键集、URL 透传、NO_PROXY)
 *   - reconcileCodexAgentProxyEnv 的对账状态机:
 *     marker 一致 → 零副作用; 漂移 → 重写 + pkill; 关闭 → 删除 + pkill;
 *     live turn → 推迟 (不写不杀); env 模式 marker 用用户 URL
 *   - applyAgentProxyForHost 的失败上报与 per-host 串行化
 *   - prefs store 的双模式 round-trip 与旧数据迁移
 *
 * prefs store 依赖 electron app.getPath, 用 vi.mock 替换; RemoteHost 用
 * 最小 fake (exec 脚本断言)。代建隧道的保活器在 agent-proxy-tunnel.test.ts
 * 单独测 — 本文件不 initAgentProxy, keeper 未装配时相关入口是 no-op。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── electron mock: prefs store 落盘到内存 Map ────────────────────────────────
let prefsFileContent: string | null = null;
vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/cindy-test-userdata',
  },
}));

// fs sync API 被 prefs store 直接用; 用内存实现替身。
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: () => prefsFileContent != null,
      readFileSync: () => prefsFileContent ?? '',
      writeFileSync: (_p: string, content: string) => {
        prefsFileContent = content;
      },
      renameSync: () => {},
      unlinkSync: () => {
        prefsFileContent = null;
      },
    },
  };
});

import {
  applyAgentProxyForHost,
  buildAgentProxyEnv,
  buildAgentProxyEnvUppercase,
  buildAgentProxyMarkerContent,
  clearAgentProxyTunnelState,
  getAgentProxyTunnelState,
  getRemoteAgentProxyEnv,
  hasPendingAgentProxyReconcile,
  initAgentProxy,
  killRemoteCodexDaemon,
  reconcileCodexAgentProxyEnv,
  resolveAgentProxyUrl,
  setAgentProxyLiveTurnChecker,
} from '../agent-proxy';
import {
  getSshHostAgentProxy,
  getSshHostAutoConnect,
  getSshHostDisplayName,
  setSshHostAgentProxy,
  setSshHostAutoConnect,
  setSshHostDisplayName,
  type SshHostAgentProxyPref,
} from '../ssh-host-prefs-store';

interface ExecCall {
  cmd: string;
  input?: string;
}

/** 最小 RemoteHost fake: 记录 exec, cat/rm marker + pkill 走脚本内容断言。 */
function makeFakeHost(opts: { marker?: string | null } = {}) {
  const state = {
    marker: opts.marker ?? null,
    execCalls: [] as ExecCall[],
    pkillCount: 0,
  };
  const host = {
    id: 'test-host',
    config: {
      id: 'test-host',
      hostname: '10.0.0.1',
      port: 22,
      user: 'deploy',
      authMethod: 'agent',
      source: 'manual',
      managedByCindy: false,
    },
    getStatus: () => 'ready',
    async exec(cmd: string, execOpts?: { input?: string }) {
      state.execCalls.push({ cmd, input: execOpts?.input });
      if (cmd.includes('cat "') && cmd.includes('agent-proxy.env')) {
        return { stdout: state.marker ?? '', stderr: '', exitCode: 0, signal: null };
      }
      if (cmd.includes('cat > "') && cmd.includes('agent-proxy.env')) {
        state.marker = (execOpts?.input ?? '').trim();
        return { stdout: '', stderr: '', exitCode: 0, signal: null };
      }
      if (cmd.includes('rm -f "') && cmd.includes('agent-proxy.env')) {
        state.marker = null;
        return { stdout: '', stderr: '', exitCode: 0, signal: null };
      }
      if (cmd.includes('pkill')) {
        state.pkillCount += 1;
        return { stdout: '', stderr: '', exitCode: 0, signal: null };
      }
      return { stdout: '', stderr: '', exitCode: 0, signal: null };
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { host: host as any, state };
}

const TUNNEL_PREF: SshHostAgentProxyPref = {
  enabled: true,
  mode: 'tunnel',
  localHost: '127.0.0.1',
  localPort: 7890,
  remotePort: 17893,
};

const ENV_PREF: SshHostAgentProxyPref = {
  enabled: true,
  mode: 'env',
  proxyUrl: 'http://127.0.0.1:7890',
};

beforeEach(() => {
  prefsFileContent = null;
  // prefs cache / tunnel state 都是模块级 — 显式清空, 防跨用例串味。
  setSshHostAgentProxy('test-host', null);
  clearAgentProxyTunnelState('test-host');
  setAgentProxyLiveTurnChecker(() => false);
});

describe('resolveAgentProxyUrl', () => {
  it('tunnel mode pins the fixed remote port; env mode passes the URL through', () => {
    expect(resolveAgentProxyUrl(TUNNEL_PREF)).toBe('http://127.0.0.1:17893');
    expect(resolveAgentProxyUrl(ENV_PREF)).toBe('http://127.0.0.1:7890');
  });
});

describe('SSH host display name preference', () => {
  it('round-trips independently from connection fields and falls back to alias', () => {
    expect(getSshHostDisplayName('test-host')).toBe('test-host');
    setSshHostDisplayName('test-host', 'Build box');
    expect(getSshHostDisplayName('test-host')).toBe('Build box');
    expect(JSON.parse(prefsFileContent ?? '{}')['test-host']).toMatchObject({
      displayName: 'Build box',
    });
  });
});

describe('buildAgentProxyEnv', () => {
  it('builds dual-case proxy env pointing at the proxy URL', () => {
    const env = buildAgentProxyEnv('http://127.0.0.1:17893');
    expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:17893');
    expect(env.HTTP_PROXY).toBe('http://127.0.0.1:17893');
    expect(env.https_proxy).toBe('http://127.0.0.1:17893');
    expect(env.http_proxy).toBe('http://127.0.0.1:17893');
    expect(env.NO_PROXY).toContain('localhost');
    expect(env.no_proxy).toContain('127.0.0.1');
  });

  it('uppercase-only variant satisfies the env-block gatekeeper', () => {
    const env = buildAgentProxyEnvUppercase('socks5://10.0.0.5:1080');
    for (const key of Object.keys(env)) {
      expect(key).toMatch(/^[A-Z_][A-Z0-9_]*$/);
    }
    expect(Object.keys(env)).toEqual(['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY']);
    expect(env.HTTPS_PROXY).toBe('socks5://10.0.0.5:1080');
  });
});

describe('buildAgentProxyMarkerContent', () => {
  it('is a sourceable shell snippet with the proxy URL', () => {
    const content = buildAgentProxyMarkerContent('http://127.0.0.1:18000');
    expect(content).toContain("export HTTPS_PROXY='http://127.0.0.1:18000'");
    expect(content).toContain("export https_proxy='http://127.0.0.1:18000'");
    expect(content).toContain("export NO_PROXY='localhost,127.0.0.1,::1'");
    expect(content.endsWith('\n')).toBe(true);
  });
});

describe('getRemoteAgentProxyEnv', () => {
  it('returns null when the pref is off', async () => {
    const { host } = makeFakeHost();
    expect(await getRemoteAgentProxyEnv(host)).toBeNull();
  });

  it('env mode returns the user URL without touching any tunnel', async () => {
    setSshHostAgentProxy('test-host', ENV_PREF);
    const { host, state } = makeFakeHost();
    const env = await getRemoteAgentProxyEnv(host);
    expect(env?.HTTPS_PROXY).toBe('http://127.0.0.1:7890');
    expect(state.execCalls).toHaveLength(0);
  });

  it('tunnel mode rejects when the keeper is not armed (fail-closed, no silent direct)', async () => {
    // 本测试文件不 initAgentProxy — keeper 未装配, ensureTunnelUp 立即拒绝。
    setSshHostAgentProxy('test-host', TUNNEL_PREF);
    const { host } = makeFakeHost();
    await expect(getRemoteAgentProxyEnv(host)).rejects.toThrow();
  });
});

describe('reconcileCodexAgentProxyEnv', () => {
  it('no-ops when the marker already matches the desired content (tunnel mode)', async () => {
    setSshHostAgentProxy('test-host', TUNNEL_PREF);
    const desired = buildAgentProxyMarkerContent('http://127.0.0.1:17893').trim();
    const { host, state } = makeFakeHost({ marker: desired });
    const result = await reconcileCodexAgentProxyEnv(host);
    expect(result).toEqual({ markerChanged: false, daemonRestarted: false });
    expect(state.pkillCount).toBe(0);
  });

  it('writes the marker and kills the daemon when drifted', async () => {
    setSshHostAgentProxy('test-host', TUNNEL_PREF);
    const { host, state } = makeFakeHost({ marker: null });
    const result = await reconcileCodexAgentProxyEnv(host);
    expect(result).toEqual({ markerChanged: true, daemonRestarted: true });
    expect(state.marker).toBe(buildAgentProxyMarkerContent('http://127.0.0.1:17893').trim());
    expect(state.pkillCount).toBe(1);
  });

  it('env mode writes the user URL verbatim into the marker', async () => {
    setSshHostAgentProxy('test-host', { ...ENV_PREF, proxyUrl: 'socks5://10.0.0.5:1080' });
    const { host, state } = makeFakeHost({ marker: null });
    const result = await reconcileCodexAgentProxyEnv(host);
    expect(result).toEqual({ markerChanged: true, daemonRestarted: true });
    expect(state.marker).toContain("export HTTPS_PROXY='socks5://10.0.0.5:1080'");
  });

  it('defers (no write, no kill) when a live turn is running on the host', async () => {
    // 漂移生效要重启 daemon → 会断 live turn: 必须推迟, 漂移持久,
    // turn-done / 下次 session start 补刀。
    setSshHostAgentProxy('test-host', TUNNEL_PREF);
    setAgentProxyLiveTurnChecker((hostId) => hostId === 'test-host');
    const { host, state } = makeFakeHost({ marker: null });
    const result = await reconcileCodexAgentProxyEnv(host);
    expect(result).toEqual({ markerChanged: false, daemonRestarted: false, deferredForLiveTurn: true });
    expect(state.marker).toBeNull();
    expect(state.pkillCount).toBe(0);

    // turn 结束后同一调用点重试 → 正常收敛。
    setAgentProxyLiveTurnChecker(() => false);
    const retry = await reconcileCodexAgentProxyEnv(host);
    expect(retry).toEqual({ markerChanged: true, daemonRestarted: true });
    expect(state.pkillCount).toBe(1);
  });

  it('live turn does not defer the fast path (marker already consistent)', async () => {
    setSshHostAgentProxy('test-host', TUNNEL_PREF);
    setAgentProxyLiveTurnChecker(() => true);
    const desired = buildAgentProxyMarkerContent('http://127.0.0.1:17893').trim();
    const { host, state } = makeFakeHost({ marker: desired });
    const result = await reconcileCodexAgentProxyEnv(host);
    expect(result).toEqual({ markerChanged: false, daemonRestarted: false });
    expect(state.pkillCount).toBe(0);
  });

  it('deletes the marker and kills the daemon when the pref is off', async () => {
    setSshHostAgentProxy('test-host', null);
    const { host, state } = makeFakeHost({ marker: "export HTTPS_PROXY='http://127.0.0.1:17893'" });
    const result = await reconcileCodexAgentProxyEnv(host);
    expect(result).toEqual({ markerChanged: true, daemonRestarted: true });
    expect(state.marker).toBeNull();
    expect(state.pkillCount).toBe(1);
  });

  it('leaves a missing marker alone when the pref is off', async () => {
    setSshHostAgentProxy('test-host', null);
    const { host, state } = makeFakeHost({ marker: null });
    const result = await reconcileCodexAgentProxyEnv(host);
    expect(result).toEqual({ markerChanged: false, daemonRestarted: false });
    expect(state.pkillCount).toBe(0);
  });

  it('fails closed when the marker write fails: throws and does not kill the daemon (codex R7 P1)', async () => {
    setSshHostAgentProxy('test-host', TUNNEL_PREF);
    const { host, state } = makeFakeHost({ marker: null });
    const baseExec = host.exec.bind(host);
    host.exec = async (cmd: string, execOpts?: { input?: string }) => {
      if (cmd.includes('cat > "') && cmd.includes('agent-proxy.env')) {
        return { stdout: '', stderr: 'Permission denied', exitCode: 1, signal: null };
      }
      return baseExec(cmd, execOpts);
    };
    await expect(reconcileCodexAgentProxyEnv(host)).rejects.toThrow(/write agent-proxy marker failed/);
    expect(state.pkillCount).toBe(0);
  });

  it('fails closed when the marker delete fails: throws and does not kill the daemon (codex R7 P1)', async () => {
    setSshHostAgentProxy('test-host', null);
    const { host, state } = makeFakeHost({ marker: "export HTTPS_PROXY='http://127.0.0.1:17893'" });
    const baseExec = host.exec.bind(host);
    host.exec = async (cmd: string, execOpts?: { input?: string }) => {
      if (cmd.includes('rm -f "') && cmd.includes('agent-proxy.env')) {
        return { stdout: '', stderr: 'Read-only file system', exitCode: 1, signal: null };
      }
      return baseExec(cmd, execOpts);
    };
    await expect(reconcileCodexAgentProxyEnv(host)).rejects.toThrow(/delete agent-proxy marker failed/);
    expect(state.pkillCount).toBe(0);
  });

  it('rolls the marker back when pkill fails so the next reconcile retries the kill (codex R10 P2)', async () => {
    setSshHostAgentProxy('test-host', null);
    const staleMarker = "export HTTPS_PROXY='http://127.0.0.1:17893'";
    const { host, state } = makeFakeHost({ marker: staleMarker });
    let pkillShouldFail = true;
    let failedPkillCount = 0;
    const baseExec = host.exec.bind(host);
    host.exec = async (cmd: string, execOpts?: { input?: string }) => {
      if (cmd.includes('pkill') && pkillShouldFail) {
        failedPkillCount += 1;
        return {
          stdout: '',
          stderr: 'daemon still alive after TERM(5s)+KILL(2s)',
          exitCode: 3,
          signal: null,
        };
      }
      return baseExec(cmd, execOpts);
    };

    const first = await reconcileCodexAgentProxyEnv(host);
    expect(first).toEqual({ markerChanged: true, daemonRestarted: false });
    // marker 已回滚到原值 (与存活 daemon 的 env 一致)。
    expect(state.marker).toBe(staleMarker);

    // 下次 reconcile 仍 drift → 重写 + 重试 kill (自愈); pkill 恢复后清干净。
    pkillShouldFail = false;
    const second = await reconcileCodexAgentProxyEnv(host);
    expect(second).toEqual({ markerChanged: true, daemonRestarted: true });
    expect(state.marker).toBeNull();
    expect(failedPkillCount).toBe(1);
    expect(state.pkillCount).toBe(1);
  });

  it('reconnect does not create drift: marker content is static per pref (fixed port)', async () => {
    // 旧方案的回归靶: 动态端口重连重绑 → marker 漂移 → pkill 正在跑的
    // daemon。固定端口下同一 pref 的 desired 恒定, 重复 reconcile 恒 fast path。
    setSshHostAgentProxy('test-host', TUNNEL_PREF);
    const { host, state } = makeFakeHost({ marker: null });
    await reconcileCodexAgentProxyEnv(host);
    expect(state.pkillCount).toBe(1);
    for (let i = 0; i < 3; i++) {
      const again = await reconcileCodexAgentProxyEnv(host);
      expect(again).toEqual({ markerChanged: false, daemonRestarted: false });
    }
    expect(state.pkillCount).toBe(1);
  });
});

describe('killRemoteCodexDaemon', () => {
  it('waits for the daemon to actually exit after TERM before returning (greptile R6 P2)', async () => {
    const { host, state } = makeFakeHost();
    const result = await killRemoteCodexDaemon(host);
    expect(result).toEqual({ ok: true });
    expect(state.pkillCount).toBe(1);
    const script = state.execCalls.find((c) => c.cmd.includes('pkill'))?.cmd ?? '';
    expect(script).toContain('pgrep');
    expect(script).toContain('pkill -9');
  });

  it('reports pkill_failed when the daemon survives TERM+KILL', async () => {
    const { host } = makeFakeHost();
    const baseExec = host.exec.bind(host);
    host.exec = async (cmd: string, execOpts?: { input?: string }) => {
      if (cmd.includes('pkill')) {
        return {
          stdout: '',
          stderr: 'daemon still alive after TERM(5s)+KILL(2s)',
          exitCode: 3,
          signal: null,
        };
      }
      return baseExec(cmd, execOpts);
    };
    const result = await killRemoteCodexDaemon(host);
    expect(result).toMatchObject({ ok: false, reason: 'pkill_failed' });
  });
});

describe('applyAgentProxyForHost', () => {
  it('env mode: reconcile succeeds and records applied evidence (phase=active)', async () => {
    // UI 只在确有应用证据时显示「已注入」(R1 review P2) — apply 成功落
    // phase='active', 未应用/推迟中无状态则渲染等待态。
    setSshHostAgentProxy('test-host', ENV_PREF);
    const { host, state } = makeFakeHost({ marker: null });
    await applyAgentProxyForHost(host);
    expect(state.marker).toContain("export HTTPS_PROXY='http://127.0.0.1:7890'");
    expect(getAgentProxyTunnelState('test-host')).toEqual({ phase: 'active' });
  });

  it('reports apply error when the daemon survives pkill during proxy disable (codex R9 P2)', async () => {
    setSshHostAgentProxy('test-host', null);
    const { host } = makeFakeHost({ marker: "export HTTPS_PROXY='http://127.0.0.1:17893'" });
    const baseExec = host.exec.bind(host);
    host.exec = async (cmd: string, execOpts?: { input?: string }) => {
      if (cmd.includes('pkill')) {
        return {
          stdout: '',
          stderr: 'daemon still alive after TERM(5s)+KILL(2s)',
          exitCode: 3,
          signal: null,
        };
      }
      return baseExec(cmd, execOpts);
    };
    await applyAgentProxyForHost(host);
    const state = getAgentProxyTunnelState('test-host');
    expect(state?.phase).toBe('error');
    expect(state?.lastError).toMatch(/survived pkill/);
  });

  it('live-turn defer is not an apply error (state untouched, retried at turn-done)', async () => {
    setSshHostAgentProxy('test-host', ENV_PREF);
    setAgentProxyLiveTurnChecker(() => true);
    const { host, state } = makeFakeHost({ marker: null });
    await applyAgentProxyForHost(host);
    expect(state.marker).toBeNull();
    expect(state.pkillCount).toBe(0);
    // defer 不是失败 — 不落 error 状态。
    expect(getAgentProxyTunnelState('test-host')?.lastError).toBeUndefined();
  });

  it('serializes concurrent reconciles per host so a fast-path caller never probes mid-restart (codex R9 P2)', async () => {
    setSshHostAgentProxy('test-host', TUNNEL_PREF);
    const { host, state } = makeFakeHost({ marker: null });

    let killStarted = false;
    const killGate: { release?: () => void } = {};
    const baseExec = host.exec.bind(host);
    host.exec = async (cmd: string, execOpts?: { input?: string }) => {
      if (cmd.includes('pkill')) {
        killStarted = true;
        await new Promise<void>((resolve) => {
          killGate.release = resolve;
        });
      }
      return baseExec(cmd, execOpts);
    };

    const order: string[] = [];
    const first = reconcileCodexAgentProxyEnv(host).then((r) => {
      order.push('first-done');
      return r;
    });
    await vi.waitFor(() => {
      expect(killStarted).toBe(true);
    });
    const second = reconcileCodexAgentProxyEnv(host).then((r) => {
      order.push('second-done');
      return r;
    });
    await Promise.resolve();
    const execCountWhileFirstBlocked = state.execCalls.length;
    await Promise.resolve();
    expect(state.execCalls.length).toBe(execCountWhileFirstBlocked);

    killGate.release?.();
    const [r1, r2] = await Promise.all([first, second]);
    expect(r1.markerChanged).toBe(true);
    expect(r1.daemonRestarted).toBe(true);
    expect(r2).toEqual({ markerChanged: false, daemonRestarted: false });
    expect(order).toEqual(['first-done', 'second-done']);
    expect(state.pkillCount).toBe(1);
  });
});

describe('ssh-host-prefs-store agentProxy', () => {
  it('round-trips a tunnel-mode pref', () => {
    setSshHostAgentProxy('h1', TUNNEL_PREF);
    expect(getSshHostAgentProxy('h1')).toEqual(TUNNEL_PREF);
  });

  it('round-trips an env-mode pref', () => {
    setSshHostAgentProxy('h1', ENV_PREF);
    expect(getSshHostAgentProxy('h1')).toEqual(ENV_PREF);
  });

  it('returns null for disabled / cleared / unknown hosts', () => {
    setSshHostAgentProxy('h1', { ...TUNNEL_PREF, enabled: false });
    expect(getSshHostAgentProxy('h1')).toBeNull();
    setSshHostAgentProxy('h2', TUNNEL_PREF);
    setSshHostAgentProxy('h2', null);
    expect(getSshHostAgentProxy('h2')).toBeNull();
    expect(getSshHostAgentProxy('never-set')).toBeNull();
  });

  it('keeps autoConnect when writing agentProxy and vice versa', () => {
    setSshHostAutoConnect('h1', true);
    setSshHostAgentProxy('h1', TUNNEL_PREF);
    expect(getSshHostAutoConnect('h1')).toBe(true);
    expect(getSshHostAgentProxy('h1')).toEqual(TUNNEL_PREF);
    setSshHostAutoConnect('h1', false);
    expect(getSshHostAgentProxy('h1')).toEqual(TUNNEL_PREF);
    expect(getSshHostAutoConnect('h1')).toBe(false);
    setSshHostAutoConnect('h1', true);
    setSshHostAgentProxy('h1', null);
    expect(getSshHostAgentProxy('h1')).toBeNull();
    expect(getSshHostAutoConnect('h1')).toBe(true);
  });

  it('rejects malformed prefs at write time', () => {
    expect(() =>
      setSshHostAgentProxy('h1', { ...TUNNEL_PREF, localHost: 'bad host' }),
    ).toThrow(/invalid agentProxy/);
    expect(() =>
      setSshHostAgentProxy('h1', { ...TUNNEL_PREF, localPort: 0 }),
    ).toThrow(/invalid agentProxy/);
    expect(() =>
      setSshHostAgentProxy('h1', { ...TUNNEL_PREF, localHost: `12'7.0.0.1` }),
    ).toThrow(/invalid agentProxy/);
    // env 模式: 非法 URL / 带引号 / 不支持的 scheme 都拒。
    expect(() =>
      setSshHostAgentProxy('h1', { ...ENV_PREF, proxyUrl: 'not a url' }),
    ).toThrow(/invalid agentProxy/);
    expect(() =>
      setSshHostAgentProxy('h1', { ...ENV_PREF, proxyUrl: "http://x'y:1" }),
    ).toThrow(/invalid agentProxy/);
    expect(() =>
      setSshHostAgentProxy('h1', { ...ENV_PREF, proxyUrl: 'ftp://127.0.0.1:21' }),
    ).toThrow(/invalid agentProxy/);
    expect(() =>
      setSshHostAgentProxy('h1', { ...ENV_PREF, proxyUrl: 'socks5://127.0.0.1:1080' }),
    ).not.toThrow();
  });
});

describe('reconcile × tunnel keeper 集成 (事务边界, R2 review P1/P3)', () => {
  class FakeTunnelConn {
    status = 'disconnected';
    armCalls: Array<Record<string, unknown>> = [];
    disconnectCount = 0;
    constructor(public id: string) {}
    getStatus() {
      return this.status;
    }
    onStatus() {
      return () => {};
    }
    async connect() {
      this.status = 'ready';
    }
    async ensureRemoteForward(spec: Record<string, unknown>) {
      this.armCalls.push(spec);
      return { remotePort: spec.preferredRemotePort as number, close: async () => {} };
    }
    async exec() {
      return { stdout: '', stderr: '', exitCode: 10, signal: null };
    }
    async disconnect() {
      this.disconnectCount += 1;
      this.status = 'disconnected';
    }
  }

  let conns: FakeTunnelConn[] = [];

  beforeEach(() => {
    conns = [];
  });

  function initKeeperWith(host: { id: string }) {
    initAgentProxy({
      broadcast: () => {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createTunnelHost: (cfg) => {
        const c = new FakeTunnelConn(cfg.id);
        conns.push(c);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return c as any;
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getMainHost: () => host as any,
    });
  }

  it('local target 变更 (remotePort 不变) 经 reconcile 迁移隧道, 不重启 daemon', async () => {
    // marker 只编码远端端口 — 该场景 marker 无漂移, 旧实现会永远沿用旧隧道
    // (R2 review P1)。
    setSshHostAgentProxy('test-host', TUNNEL_PREF);
    const desired = buildAgentProxyMarkerContent('http://127.0.0.1:17893').trim();
    const { host, state } = makeFakeHost({ marker: desired });
    initKeeperWith(host);
    await reconcileCodexAgentProxyEnv(host);
    expect(conns).toHaveLength(1);
    expect(conns[0]!.armCalls[0]).toMatchObject({ localPort: 7890 });

    setSshHostAgentProxy('test-host', { ...TUNNEL_PREF, localPort: 1080 });
    const result = await reconcileCodexAgentProxyEnv(host);
    // tunnel-only 迁移: 不写 marker、不杀 daemon。
    expect(result).toEqual({ markerChanged: false, daemonRestarted: false });
    expect(state.pkillCount).toBe(0);
    expect(conns).toHaveLength(2);
    expect(conns[0]!.disconnectCount).toBe(1);
    expect(conns[1]!.armCalls[0]).toMatchObject({ localPort: 1080, preferredRemotePort: 17893 });
    expect(hasPendingAgentProxyReconcile('test-host')).toBe(false);
  });

  it('tunnel 漂移 (含 local target 变更) 同样受 live-turn gate 保护', async () => {
    setSshHostAgentProxy('test-host', TUNNEL_PREF);
    const desired = buildAgentProxyMarkerContent('http://127.0.0.1:17893').trim();
    const { host } = makeFakeHost({ marker: desired });
    initKeeperWith(host);
    await reconcileCodexAgentProxyEnv(host);
    expect(conns).toHaveLength(1);

    setSshHostAgentProxy('test-host', { ...TUNNEL_PREF, localPort: 1080 });
    setAgentProxyLiveTurnChecker(() => true);
    const deferred = await reconcileCodexAgentProxyEnv(host);
    expect(deferred).toMatchObject({ deferredForLiveTurn: true });
    // 隧道原样不动, pending 记账等 turn-done 补刀。
    expect(conns).toHaveLength(1);
    expect(conns[0]!.disconnectCount).toBe(0);
    expect(hasPendingAgentProxyReconcile('test-host')).toBe(true);

    setAgentProxyLiveTurnChecker(() => false);
    await reconcileCodexAgentProxyEnv(host);
    expect(conns).toHaveLength(2);
    expect(hasPendingAgentProxyReconcile('test-host')).toBe(false);
  });

  it('marker 写失败时旧隧道原样保留 (迁移在 write/kill 之后)', async () => {
    setSshHostAgentProxy('test-host', TUNNEL_PREF);
    const desired = buildAgentProxyMarkerContent('http://127.0.0.1:17893').trim();
    const { host } = makeFakeHost({ marker: desired });
    initKeeperWith(host);
    await reconcileCodexAgentProxyEnv(host);
    expect(conns).toHaveLength(1);

    // 远端端口迁移 17893 → 18000, 但 marker 写失败。
    setSshHostAgentProxy('test-host', { ...TUNNEL_PREF, remotePort: 18000 });
    const baseExec = host.exec.bind(host);
    host.exec = async (cmd: string, execOpts?: { input?: string }) => {
      if (cmd.includes('cat > "') && cmd.includes('agent-proxy.env')) {
        return { stdout: '', stderr: 'Read-only file system', exitCode: 1, signal: null };
      }
      return baseExec(cmd, execOpts);
    };
    await expect(reconcileCodexAgentProxyEnv(host)).rejects.toThrow(/write agent-proxy marker failed/);
    // 旧隧道未被拆 (R2 review P1), 失败已记 pending (R2 review P2)。
    expect(conns).toHaveLength(1);
    expect(conns[0]!.disconnectCount).toBe(0);
    expect(hasPendingAgentProxyReconcile('test-host')).toBe(true);
  });

  it('pkill 失败回滚时旧隧道原样保留', async () => {
    setSshHostAgentProxy('test-host', TUNNEL_PREF);
    const desired = buildAgentProxyMarkerContent('http://127.0.0.1:17893').trim();
    const { host, state } = makeFakeHost({ marker: desired });
    initKeeperWith(host);
    await reconcileCodexAgentProxyEnv(host);
    expect(conns).toHaveLength(1);

    setSshHostAgentProxy('test-host', { ...TUNNEL_PREF, remotePort: 18000 });
    const baseExec = host.exec.bind(host);
    host.exec = async (cmd: string, execOpts?: { input?: string }) => {
      if (cmd.includes('pkill')) {
        return {
          stdout: '',
          stderr: 'daemon still alive after TERM(5s)+KILL(2s)',
          exitCode: 3,
          signal: null,
        };
      }
      return baseExec(cmd, execOpts);
    };
    const result = await reconcileCodexAgentProxyEnv(host);
    expect(result).toEqual({ markerChanged: true, daemonRestarted: false });
    // marker 已回滚, 存活 daemon 仍指旧端口 — 旧隧道保留兜底。
    expect(state.marker).toBe(desired);
    expect(conns).toHaveLength(1);
    expect(conns[0]!.disconnectCount).toBe(0);
    expect(hasPendingAgentProxyReconcile('test-host')).toBe(true);
  });

  it('远端端口迁移成功: marker → kill → 隧道迁移的完整事务', async () => {
    setSshHostAgentProxy('test-host', TUNNEL_PREF);
    const desired = buildAgentProxyMarkerContent('http://127.0.0.1:17893').trim();
    const { host, state } = makeFakeHost({ marker: desired });
    initKeeperWith(host);
    await reconcileCodexAgentProxyEnv(host);

    setSshHostAgentProxy('test-host', { ...TUNNEL_PREF, remotePort: 18000 });
    const result = await reconcileCodexAgentProxyEnv(host);
    expect(result).toEqual({ markerChanged: true, daemonRestarted: true });
    expect(state.marker).toBe(buildAgentProxyMarkerContent('http://127.0.0.1:18000').trim());
    expect(state.pkillCount).toBe(1);
    expect(conns).toHaveLength(2);
    expect(conns[0]!.disconnectCount).toBe(1);
    expect(conns[1]!.armCalls[0]).toMatchObject({ preferredRemotePort: 18000 });
    expect(hasPendingAgentProxyReconcile('test-host')).toBe(false);
  });

  it('pref 关闭: daemon 以空 env 重启成功后才拆隧道', async () => {
    setSshHostAgentProxy('test-host', TUNNEL_PREF);
    const desired = buildAgentProxyMarkerContent('http://127.0.0.1:17893').trim();
    const { host, state } = makeFakeHost({ marker: desired });
    initKeeperWith(host);
    await reconcileCodexAgentProxyEnv(host);
    expect(conns).toHaveLength(1);

    setSshHostAgentProxy('test-host', null);
    const result = await reconcileCodexAgentProxyEnv(host);
    expect(result).toEqual({ markerChanged: true, daemonRestarted: true });
    expect(state.marker).toBeNull();
    expect(conns[0]!.disconnectCount).toBe(1);
  });
});

describe('ssh-host-prefs-store legacy migration', () => {
  it('migrates a pre-mode pref ({enabled,localHost,localPort}) to tunnel mode with the legacy fixed port', async () => {
    // 旧 PR #715 数据形态直接落盘 → 重新加载模块 (绕过内存 cache) 读回。
    prefsFileContent = JSON.stringify({
      'legacy-host': {
        autoConnect: true,
        agentProxy: { enabled: true, localHost: '127.0.0.1', localPort: 7890 },
      },
    });
    vi.resetModules();
    const fresh = await import('../ssh-host-prefs-store');
    expect(fresh.getSshHostAgentProxy('legacy-host')).toEqual({
      enabled: true,
      mode: 'tunnel',
      localHost: '127.0.0.1',
      localPort: 7890,
      remotePort: fresh.LEGACY_AGENT_PROXY_REMOTE_PORT,
    });
    expect(fresh.getSshHostAutoConnect('legacy-host')).toBe(true);
  });

  it('rejects hand-edited invalid agentProxy values instead of silently resurrecting them', async () => {
    // 用户手编 prefs 写了非法值 (端口 0 / 带引号 host): 迁移时被丢弃为
    // 「未配置」而不是恢复成可用 pref (review: 迁移边界 — 否则功能看似
    // 开着实际已静默失效, 连警告都没有)。
    prefsFileContent = JSON.stringify({
      'bad-port-host': {
        autoConnect: true,
        agentProxy: { enabled: true, localHost: '127.0.0.1', localPort: 0 },
      },
      'bad-quote-host': {
        autoConnect: false,
        agentProxy: { enabled: true, localHost: `12'7.0.0.1`, localPort: 7890 },
      },
    });
    vi.resetModules();
    const fresh = await import('../ssh-host-prefs-store');
    expect(fresh.getSshHostAgentProxy('bad-port-host')).toBeNull();
    expect(fresh.getSshHostAgentProxy('bad-quote-host')).toBeNull();
    // autoConnect 等兄弟字段不受 agentProxy 非法影响。
    expect(fresh.getSshHostAutoConnect('bad-port-host')).toBe(true);
  });
});
