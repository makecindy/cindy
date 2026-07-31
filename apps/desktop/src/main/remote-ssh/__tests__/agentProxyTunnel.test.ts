/**
 * agent-proxy-tunnel 保活器单测。
 *
 * 覆盖:
 *   - ensureTunnelUp: 独立连接 connect + 固定端口 arm (exactRemotePort) → active
 *   - 固定端口被占: 连续失败后触发残留监听清理 (protect pid 校验), 清理成功
 *     立即重试; 清理被拒继续退避
 *   - 主连接不 ready: 保活挂起 (paused), 不空转
 *   - stopTunnelForHost: 拆连接 + 状态清空
 *   - pref 目标变更: 旧连接拆除, 新连接重建
 *
 * RemoteHost 用最小 fake; prefs 经 deps.getPref 注入 (不 mock electron)。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  disposeAllTunnels,
  ensureTunnelForHost,
  ensureTunnelUp,
  getTunnelKeeperState,
  initAgentProxyTunnelKeeper,
  pauseTunnelForHost,
  stopTunnelForHost,
  type TunnelKeeperState,
} from '../agent-proxy-tunnel';
import type { SshHostAgentProxyPref } from '../ssh-host-prefs-store';

interface StatusSnap {
  config: { id: string };
  status: string;
  lastError?: string;
  statusChangedAt: number;
}

class FakeTunnelConn {
  status = 'disconnected';
  listeners = new Set<(snap: StatusSnap) => void>();
  armCalls: Array<Record<string, unknown>> = [];
  execCalls: string[] = [];
  armFailuresRemaining = 0;
  cleanupExitCode = 10; // no-holder
  disconnectCount = 0;
  constructor(public id: string) {}
  getStatus() {
    return this.status;
  }
  onStatus(cb: (snap: StatusSnap) => void) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  emitStatus(status: string, lastError?: string) {
    this.status = status;
    for (const cb of [...this.listeners]) {
      cb({ config: { id: this.id }, status, lastError, statusChangedAt: 0 });
    }
  }
  async connect() {
    this.status = 'ready';
  }
  async ensureRemoteForward(spec: Record<string, unknown>) {
    this.armCalls.push(spec);
    if (this.armFailuresRemaining > 0) {
      this.armFailuresRemaining -= 1;
      throw new Error('remote port forwarding failed on test-host (tried 127.0.0.1:45000)');
    }
    return { remotePort: spec.preferredRemotePort as number, close: async () => {} };
  }
  async exec(cmd: string) {
    this.execCalls.push(cmd);
    return { stdout: '', stderr: 'declined', exitCode: this.cleanupExitCode, signal: null };
  }
  async disconnect() {
    this.disconnectCount += 1;
    this.status = 'disconnected';
  }
}

const HOST_CFG = {
  id: 'test-host',
  hostname: '10.0.0.1',
  port: 22,
  user: 'deploy',
  authMethod: 'agent' as const,
  source: 'manual' as const,
};

const TUNNEL_PREF: SshHostAgentProxyPref = {
  enabled: true,
  mode: 'tunnel',
  localHost: '127.0.0.1',
  localPort: 7890,
  remotePort: 45000,
};

function makeHarness(opts: { pref?: SshHostAgentProxyPref | null; mainReady?: boolean } = {}) {
  const conns: FakeTunnelConn[] = [];
  const states: Array<TunnelKeeperState | null> = [];
  const harness = {
    pref: opts.pref === undefined ? TUNNEL_PREF : opts.pref,
    mainReady: opts.mainReady ?? true,
    mainExecResult: { stdout: '4242', stderr: '', exitCode: 0, signal: null },
    /** 新建隧道连接时的预设钩子 (在首次 arm 前生效)。 */
    setupConn: (_conn: FakeTunnelConn) => {},
    conns,
    states,
    mainHost: {
      id: 'test-host',
      config: HOST_CFG,
      getStatus: () => (harness.mainReady ? 'ready' : 'disconnected'),
      exec: async () => harness.mainExecResult,
    },
  };
  initAgentProxyTunnelKeeper({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createTunnelHost: (cfg) => {
      const conn = new FakeTunnelConn(cfg.id);
      harness.setupConn(conn);
      conns.push(conn);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return conn as any;
    },
    getPref: () => harness.pref,
    isMainHostReady: () => harness.mainReady,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getMainHost: () => (harness.mainReady ? (harness.mainHost as any) : null),
    onState: (_hostId, state) => {
      states.push(state);
    },
    logger: { info: () => {}, warn: () => {} },
  });
  return harness;
}

beforeEach(async () => {
  await disposeAllTunnels();
});

afterEach(async () => {
  vi.useRealTimers();
  await disposeAllTunnels();
});

describe('agent-proxy tunnel keeper', () => {
  it('connects the dedicated conn, arms the fixed port and reports active', async () => {
    const h = makeHarness();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await ensureTunnelUp(h.mainHost as any, 5_000);
    expect(result).toEqual({ remotePort: 45000 });
    expect(h.conns).toHaveLength(1);
    expect(h.conns[0]!.armCalls[0]).toMatchObject({
      localHost: '127.0.0.1',
      localPort: 7890,
      preferredRemotePort: 45000,
      exactRemotePort: true,
    });
    expect(getTunnelKeeperState('test-host')).toMatchObject({ phase: 'active', remotePort: 45000 });
  });

  it('does nothing when the pref is off or env-mode', async () => {
    const h = makeHarness({ pref: null });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ensureTunnelForHost(h.mainHost as any);
    expect(h.conns).toHaveLength(0);
    h.pref = { enabled: true, mode: 'env', proxyUrl: 'http://127.0.0.1:7890' };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ensureTunnelForHost(h.mainHost as any);
    expect(h.conns).toHaveLength(0);
  });

  it('pauses (no connect attempts) while the main connection is down, resumes on ensure', async () => {
    const h = makeHarness({ mainReady: false });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ensureTunnelForHost(h.mainHost as any);
    await vi.waitFor(() => {
      expect(getTunnelKeeperState('test-host')?.phase).toBe('paused');
    });
    expect(h.conns[0]!.armCalls).toHaveLength(0);

    // 主连接恢复 → ready 钩子重新 ensure → 正常建立。
    h.mainReady = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await ensureTunnelUp(h.mainHost as any, 5_000);
    expect(getTunnelKeeperState('test-host')?.phase).toBe('active');
  });

  it('retries the busy fixed port, runs stale-listener cleanup after 2 failures, then re-arms', async () => {
    vi.useFakeTimers();
    const h = makeHarness();
    // 前两次 arm 失败 (残留监听占着固定端口); 清理脚本 exit 0 = 已 kill。
    h.setupConn = (conn) => {
      conn.armFailuresRemaining = 2;
      conn.cleanupExitCode = 0;
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const upPromise = ensureTunnelUp(h.mainHost as any, 60_000);
    upPromise.catch(() => {});
    // 第一次 arm 失败 (streak 1): 退避等待, 未触发清理。
    await vi.waitFor(() => {
      expect(h.conns[0]!.armCalls.length).toBe(1);
    });
    expect(h.conns[0]!.execCalls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(3_000); // 第一档退避
    // 第二次失败 (streak=2) → 清理触发: 先查主连接 sshd pid, 再在隧道连接
    // 上跑清理脚本; exit 0 = 已 kill → 立即补跑 (kickPending), 第三次成功。
    await vi.waitFor(() => {
      expect(h.conns[0]!.execCalls.length).toBeGreaterThanOrEqual(1);
    });
    await vi.advanceTimersByTimeAsync(10);
    await vi.waitFor(() => {
      expect(h.conns[0]!.armCalls.length).toBe(3);
    });
    await expect(upPromise).resolves.toEqual({ remotePort: 45000 });
    const cleanupScript = h.conns[0]!.execCalls.join('\n');
    expect(cleanupScript).toContain('PORT=45000');
    expect(cleanupScript).toContain('PROTECT=4242');
    expect(getTunnelKeeperState('test-host')?.phase).toBe('active');
  });

  it('declined cleanup keeps waiting with backoff instead of killing anything', async () => {
    vi.useFakeTimers();
    const h = makeHarness();
    // 持续失败 + 清理被拒 (exit 11: holder 是控制连接自身 — 比如用户把固定
    // 端口配成了 MCP 转发口)。
    h.setupConn = (conn) => {
      conn.armFailuresRemaining = 99;
      conn.cleanupExitCode = 11;
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ensureTunnelForHost(h.mainHost as any);
    await vi.waitFor(() => {
      expect(h.conns).toHaveLength(1);
    });
    const conn = h.conns[0]!;
    // 走过前两次失败 (0s + 3s) 触发清理, 清理被拒 → 继续退避。
    await vi.waitFor(() => {
      expect(conn.armCalls.length).toBeGreaterThanOrEqual(1);
    });
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.waitFor(() => {
      expect(conn.armCalls.length).toBeGreaterThanOrEqual(2);
    });
    await vi.waitFor(() => {
      expect(conn.execCalls.length).toBeGreaterThanOrEqual(1);
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(getTunnelKeeperState('test-host')?.phase).toBe('port-busy');
    // 清理只试一次 (per busy-streak), 不反复 kill。
    expect(conn.execCalls).toHaveLength(1);
  });

  it('takes over reconnection with unbounded backoff after the conn reaches failed', async () => {
    vi.useFakeTimers();
    const h = makeHarness();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await ensureTunnelUp(h.mainHost as any, 5_000);
    const conn = h.conns[0]!;
    const connectSpy = vi.spyOn(conn, 'connect');
    // RemoteHost 自己的 5 次重连耗尽 → failed; keeper 接管退避重连。
    conn.emitStatus('failed', 'keepalive timeout');
    expect(getTunnelKeeperState('test-host')).toMatchObject({ phase: 'error', lastError: 'keepalive timeout' });
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.waitFor(() => {
      expect(connectSpy).toHaveBeenCalled();
    });
    await vi.waitFor(() => {
      expect(getTunnelKeeperState('test-host')?.phase).toBe('active');
    });
  });

  it('keeps a live tunnel serving while the main connection is down (pause ≠ teardown)', async () => {
    const h = makeHarness();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await ensureTunnelUp(h.mainHost as any, 5_000);
    h.mainReady = false;
    pauseTunnelForHost('test-host');
    // 隧道连接仍 ready + armed: 不拆, 状态保持 active。
    expect(h.conns[0]!.disconnectCount).toBe(0);
    expect(getTunnelKeeperState('test-host')?.phase).toBe('active');
  });

  it('stopTunnelForHost tears down the conn and clears state', async () => {
    const h = makeHarness();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await ensureTunnelUp(h.mainHost as any, 5_000);
    await stopTunnelForHost('test-host');
    expect(h.conns[0]!.disconnectCount).toBe(1);
    expect(getTunnelKeeperState('test-host')).toBeNull();
    expect(h.states[h.states.length - 1]).toBeNull();
  });

  it('keeps serving the old tunnel when the pref changes without rebuild permission', async () => {
    // pref 编辑后旧隧道可能还在服务存活 daemon 的流量 — 未获准迁移
    // (allowRebuild 缺省 false) 时沿用旧隧道, 返回现役真实端口
    // (R1 review P1: 拆/换隧道与杀 daemon 同级, 只能在 reconcile 的
    // live-turn gate 后发生)。
    const h = makeHarness();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await ensureTunnelUp(h.mainHost as any, 5_000);
    expect(h.conns).toHaveLength(1);
    h.pref = { ...TUNNEL_PREF, remotePort: 45001 };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await ensureTunnelUp(h.mainHost as any, 5_000);
    expect(result).toEqual({ remotePort: 45000 });
    expect(h.conns).toHaveLength(1);
    expect(h.conns[0]!.disconnectCount).toBe(0);
  });

  it('rebuilds when the main host connection config changes with the same pref (R3 review P1)', async () => {
    // hostname/user/port 等连接字段变更后, 旧 entry 的独立连接还连着旧
    // 机器 — key 含连接指纹, reconcile 的 allowRebuild 迁移必须换新连接。
    const h = makeHarness();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await ensureTunnelUp(h.mainHost as any, 5_000);
    expect(h.conns).toHaveLength(1);
    h.mainHost.config = { ...HOST_CFG, hostname: '10.0.0.2' };
    // 未获准迁移时沿用旧连接 (与 pref 变更同语义)。
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await ensureTunnelUp(h.mainHost as any, 5_000);
    expect(h.conns).toHaveLength(1);
    // reconcile 路径 (allowRebuild) 迁移到新机器。
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ensureTunnelForHost(h.mainHost as any, { allowRebuild: true });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await ensureTunnelUp(h.mainHost as any, 5_000);
    expect(h.conns).toHaveLength(2);
    await vi.waitFor(() => {
      expect(h.conns[0]!.disconnectCount).toBe(1);
    });
  });

  it('late teardown of a replaced entry does not clobber the new active state (R3 review P2)', async () => {
    const h = makeHarness();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await ensureTunnelUp(h.mainHost as any, 5_000);
    const old = h.conns[0]!;
    // 旧连接 disconnect 拖慢 — 新隧道先 armed, 旧 teardown 后完成。
    let releaseDisconnect: (() => void) | null = null;
    old.disconnect = async () => {
      await new Promise<void>((resolve) => {
        releaseDisconnect = resolve;
      });
      old.disconnectCount += 1;
      old.status = 'disconnected';
    };
    h.pref = { ...TUNNEL_PREF, remotePort: 45001 };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ensureTunnelForHost(h.mainHost as any, { allowRebuild: true });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await ensureTunnelUp(h.mainHost as any, 5_000);
    expect(getTunnelKeeperState('test-host')?.phase).toBe('active');
    releaseDisconnect!();
    await new Promise((r) => setTimeout(r, 20));
    // 迟到的旧 teardown 不得把新隧道的 active 状态清成 null。
    expect(h.states[h.states.length - 1]).toMatchObject({ phase: 'active', remotePort: 45001 });
    expect(getTunnelKeeperState('test-host')?.phase).toBe('active');
  });

  it('rebuilds the tunnel when the pref target changes and rebuild is allowed (reconcile path)', async () => {
    const h = makeHarness();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await ensureTunnelUp(h.mainHost as any, 5_000);
    expect(h.conns).toHaveLength(1);
    h.pref = { ...TUNNEL_PREF, remotePort: 45001 };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ensureTunnelForHost(h.mainHost as any, { allowRebuild: true });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await ensureTunnelUp(h.mainHost as any, 5_000);
    expect(result).toEqual({ remotePort: 45001 });
    expect(h.conns).toHaveLength(2);
    await vi.waitFor(() => {
      expect(h.conns[0]!.disconnectCount).toBe(1);
    });
    expect(h.conns[1]!.armCalls[0]).toMatchObject({ preferredRemotePort: 45001 });
  });

  it('late in-flight cycle of a stopped entry does not pollute the reported state', async () => {
    // stop/rebuild 后迟到的旧 cycle 回写会把「已拆除/新 entry」的状态覆盖
    // 成旧端口 active (R1 review P1) — setState 的 isCurrent 守卫拦截。
    const h = makeHarness();
    let releaseArm: (() => void) | null = null;
    h.setupConn = (conn) => {
      const baseArm = conn.ensureRemoteForward.bind(conn);
      conn.ensureRemoteForward = async (spec: Record<string, unknown>) => {
        // arm 挂起, 等测试显式放行 — 模拟 stop 发生在 arm 在飞期间。
        await new Promise<void>((resolve) => {
          releaseArm = resolve;
        });
        return baseArm(spec);
      };
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ensureTunnelForHost(h.mainHost as any);
    await vi.waitFor(() => {
      expect(releaseArm).not.toBeNull();
    });
    await stopTunnelForHost('test-host');
    expect(h.states[h.states.length - 1]).toBeNull();
    releaseArm!();
    // 给迟到的 cycle 一点时间收尾 — 不得再推任何状态帧。
    await new Promise((r) => setTimeout(r, 20));
    expect(h.states[h.states.length - 1]).toBeNull();
    expect(getTunnelKeeperState('test-host')).toBeNull();
  });
});
