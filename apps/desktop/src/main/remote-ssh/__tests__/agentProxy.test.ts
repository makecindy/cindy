/**
 * agent-proxy 策略层单测。
 *
 * 覆盖:
 *   - buildAgentProxyEnv / buildAgentProxyEnvUppercase / buildAgentProxyMarkerContent
 *     的内容契约 (env 键集、URL 形态、NO_PROXY)
 *   - reconcileCodexAgentProxyEnv 的对账状态机:
 *     marker 一致 → 零副作用; 漂移 → 重写 + pkill; 关闭 → 删除 + pkill
 *   - ensureAgentProxyTunnel 的 pref gate (关 → null, 开 → 建隧道)
 *
 * prefs store 依赖 electron app.getPath, 用 vi.mock 替换; RemoteHost 用
 * 最小 fake (exec 脚本断言 + ensureRemoteForward stub)。
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
  ensureAgentProxyTunnel,
  getAgentProxyTunnelState,
  killRemoteCodexDaemon,
  reconcileCodexAgentProxyEnv,
} from '../agent-proxy';
import {
  getSshHostAgentProxy,
  getSshHostAutoConnect,
  setSshHostAgentProxy,
  setSshHostAutoConnect,
} from '../ssh-host-prefs-store';

interface ExecCall {
  cmd: string;
  input?: string;
}

/** 最小 RemoteHost fake: 记录 exec, cat/rm marker + pkill 走脚本内容断言。 */
function makeFakeHost(opts: { marker?: string | null; remotePort?: number } = {}) {
  const state = {
    marker: opts.marker ?? null,
    execCalls: [] as ExecCall[],
    pkillCount: 0,
    forwards: [] as Array<{ localHost: string; localPort: number; remotePort: number }>,
  };
  const host = {
    id: 'test-host',
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
    async ensureRemoteForward(spec: { localHost: string; localPort: number }) {
      const remotePort = opts.remotePort ?? 17893;
      state.forwards.push({ ...spec, remotePort });
      return { remotePort, close: async () => {} };
    },
    async closeAllRemoteForwards() {
      state.forwards = [];
    },
    async closeRemoteForward(localHost: string, localPort: number) {
      state.forwards = state.forwards.filter(
        (f) => !(f.localHost === localHost && f.localPort === localPort),
      );
    },
    listRemoteForwards() {
      return state.forwards.map((f) => ({ ...f, armed: true }));
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { host: host as any, state };
}

const PREF = { enabled: true, localHost: '127.0.0.1', localPort: 7890 };

beforeEach(() => {
  prefsFileContent = null;
});

describe('buildAgentProxyEnv', () => {
  it('builds dual-case proxy env pointing at the tunnel port', () => {
    const env = buildAgentProxyEnv(17893);
    expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:17893');
    expect(env.HTTP_PROXY).toBe('http://127.0.0.1:17893');
    expect(env.https_proxy).toBe('http://127.0.0.1:17893');
    expect(env.http_proxy).toBe('http://127.0.0.1:17893');
    expect(env.NO_PROXY).toContain('localhost');
    expect(env.no_proxy).toContain('127.0.0.1');
  });

  it('uppercase-only variant satisfies the env-block gatekeeper', () => {
    const env = buildAgentProxyEnvUppercase(17893);
    for (const key of Object.keys(env)) {
      expect(key).toMatch(/^[A-Z_][A-Z0-9_]*$/);
    }
    expect(Object.keys(env)).toEqual(['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY']);
  });
});

describe('buildAgentProxyMarkerContent', () => {
  it('is a sourceable shell snippet with the tunnel URL', () => {
    const content = buildAgentProxyMarkerContent(18000);
    expect(content).toContain("export HTTPS_PROXY='http://127.0.0.1:18000'");
    expect(content).toContain("export https_proxy='http://127.0.0.1:18000'");
    expect(content).toContain("export NO_PROXY='localhost,127.0.0.1,::1'");
    expect(content.endsWith('\n')).toBe(true);
  });
});

describe('ensureAgentProxyTunnel', () => {
  it('returns null when the pref is off', async () => {
    const { host, state } = makeFakeHost();
    const result = await ensureAgentProxyTunnel(host);
    expect(result).toBeNull();
    expect(state.forwards).toHaveLength(0);
  });

  it('opens the forward to the pref target when enabled', async () => {
    setSshHostAgentProxy('test-host', PREF);
    const { host, state } = makeFakeHost();
    const result = await ensureAgentProxyTunnel(host);
    expect(result).toEqual({ remotePort: 17893, staleForwards: [] });
    expect(state.forwards).toEqual([{ localHost: '127.0.0.1', localPort: 7890, remotePort: 17893 }]);
  });

  it('closes stale forwards whose target no longer matches the pref (review R5)', async () => {
    // pref 目标被编辑 (7890 → 1080): 旧目标的 forward 必须拆掉, 否则残留并
    // 随重连 re-arm, 远端多暴露一个隧道口。
    setSshHostAgentProxy('test-host', PREF);
    const { host, state } = makeFakeHost();
    await ensureAgentProxyTunnel(host);
    expect(state.forwards).toHaveLength(1);

    setSshHostAgentProxy('test-host', { ...PREF, localPort: 1080 });
    const result = await ensureAgentProxyTunnel(host);
    expect(result).toMatchObject({ remotePort: 17893 });
    expect(result?.staleForwards).toHaveLength(1);
    expect(result?.staleForwards[0]).toMatchObject({ localHost: '127.0.0.1', localPort: 7890 });
    // 旧 7890 已拆 (默认 closeStale 立即拆), 只剩新 1080。
    expect(state.forwards).toEqual([{ localHost: '127.0.0.1', localPort: 1080, remotePort: 17893 }]);
  });
});

describe('reconcileCodexAgentProxyEnv', () => {
  it('no-ops when the marker already matches the desired content', async () => {
    setSshHostAgentProxy('test-host', PREF);
    const desired = buildAgentProxyMarkerContent(17893).trim();
    const { host, state } = makeFakeHost({ marker: desired });
    const result = await reconcileCodexAgentProxyEnv(host);
    expect(result).toEqual({ markerChanged: false, daemonRestarted: false });
    expect(state.pkillCount).toBe(0);
  });

  it('writes the marker and kills the daemon when drifted', async () => {
    setSshHostAgentProxy('test-host', PREF);
    const { host, state } = makeFakeHost({ marker: null });
    const result = await reconcileCodexAgentProxyEnv(host);
    expect(result).toEqual({ markerChanged: true, daemonRestarted: true });
    expect(state.marker).toBe(buildAgentProxyMarkerContent(17893).trim());
    expect(state.pkillCount).toBe(1);
  });

  it('deletes the marker and kills the daemon when the pref is off', async () => {
    // 模块级 prefs cache 跨用例共享 — 显式清除, 模拟 "pref 关闭" 场景。
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
    // exec 对非零退出码 resolve 不 throw — 写失败必须显式挡, 否则 reconcile
    // 继续 pkill, daemon 起来没 marker 直连, fail-closed 破。
    setSshHostAgentProxy('test-host', PREF);
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
    // disable 场景 (desired=null, current=旧 proxy marker): pkill 失败时若让
    // marker 停在 null, 下次 reconcile 命中 fast path (null===null) 永不重试
    // kill — 存活 daemon 握着指向已拆隧道的 proxy env 一直跑到手动重启。
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
    // 两次 reconcile 各发了一次 pkill: 第一次失败 (mock 拦截), 第二次重试成功。
    expect(failedPkillCount).toBe(1);
    expect(state.pkillCount).toBe(1);
  });

  it('closes the old forward only after the daemon restart succeeds during a rebind (codex R17 P2)', async () => {
    // rebind (7890 → 1080): reconcile 先建后拆 — daemon 重启成功后才拆旧。
    setSshHostAgentProxy('test-host', PREF);
    const { host, state } = makeFakeHost({ marker: null });
    // 端口递增分配, 让 rebind 后 desired marker 与旧 marker 不同 (fake 默认
    // 恒 17893 时 marker 内容不变会走 fast path, 测不到拆旧时机)。
    let nextPort = 17893;
    host.ensureRemoteForward = async (spec: { localHost: string; localPort: number }) => {
      const remotePort = nextPort;
      nextPort += 1;
      state.forwards.push({ ...spec, remotePort });
      return { remotePort, close: async () => {} };
    };
    // 先 enable 成功 (旧目标 7890: forward + marker 都就位)。
    await reconcileCodexAgentProxyEnv(host);
    expect(state.forwards).toEqual([{ localHost: '127.0.0.1', localPort: 7890, remotePort: 17893 }]);

    setSshHostAgentProxy('test-host', { ...PREF, localPort: 1080 });
    const result = await reconcileCodexAgentProxyEnv(host);
    expect(result).toEqual({ markerChanged: true, daemonRestarted: true });
    // daemon 重启成功 → 旧 7890 已拆, 只剩新 1080。
    expect(state.forwards).toEqual([{ localHost: '127.0.0.1', localPort: 1080, remotePort: 17894 }]);
  });

  it('keeps the old forward when the daemon survives pkill during a rebind (codex R17 P2)', async () => {
    // rebind + pkill 失败: marker 回滚 (R10), 旧 7890 forward 保留 (存活
    // daemon 流量不断), 新 1080 forward 闲置待下轮 reconcile 复用。
    setSshHostAgentProxy('test-host', PREF);
    const { host, state } = makeFakeHost({ marker: null });
    let nextPort = 17893;
    host.ensureRemoteForward = async (spec: { localHost: string; localPort: number }) => {
      const remotePort = nextPort;
      nextPort += 1;
      state.forwards.push({ ...spec, remotePort });
      return { remotePort, close: async () => {} };
    };
    await reconcileCodexAgentProxyEnv(host);
    const oldMarker = state.marker;

    setSshHostAgentProxy('test-host', { ...PREF, localPort: 1080 });
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
    // marker 回滚到旧值; 旧 7890 保留; 新 1080 闲置 (不拆任何 forward)。
    expect(state.marker).toBe(oldMarker);
    expect(state.forwards).toEqual([
      { localHost: '127.0.0.1', localPort: 7890, remotePort: 17893 },
      { localHost: '127.0.0.1', localPort: 1080, remotePort: 17894 },
    ]);
  });
});

describe('killRemoteCodexDaemon', () => {
  it('waits for the daemon to actually exit after TERM before returning (greptile R6 P2)', async () => {
    // pkill 只保证信号送达 — 脚本必须 TERM 后轮询等进程消失, 没死透再 KILL,
    // 防旧 daemon 在 dying 窗口里响应探活被复用 (旧 env, marker 变更静默落空)。
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

describe('applyAgentProxyForHost disable path', () => {
  it('reports apply error when the daemon survives pkill during proxy disable (codex R9 P2)', async () => {
    // 先 enable 建隧道 (marker 已就位)。
    setSshHostAgentProxy('test-host', PREF);
    const { host } = makeFakeHost({ marker: "export HTTPS_PROXY='http://127.0.0.1:17893'" });
    await applyAgentProxyForHost(host);
    expect(getAgentProxyTunnelState('test-host')?.active).toBe(true);

    // disable: 隧道拆 + marker 清, 但 daemon 没死透 — 旧 daemon 还握着指向
    // 已关闭端口的 proxy env, 卡片必须落错误而不是谎称「已关闭」。
    setSshHostAgentProxy('test-host', null);
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
    expect(state?.active).toBe(false);
    expect(state?.lastError).toMatch(/survived pkill/);
  });

  it('serializes concurrent reconciles per host so a fast-path caller never probes mid-restart (codex R9 P2)', async () => {
    // 并发 reconcile (两个 transport 的 beforeDaemonProbe 同时触发): 第一个
    // 还在等 killRemoteCodexDaemon 时, 第二个必须排队, 不得走 marker-match
    // fast path 直接去 probe 旧 daemon。
    setSshHostAgentProxy('test-host', PREF);
    const { host, state } = makeFakeHost({ marker: null });

    let killStarted = false;
    // 对象持有 release: TS 不对属性做 closure 收窄 (let 声明会被 narrow 成
    // undefined → CI typecheck TS2349 "Type 'never' has no call signatures")。
    const killGate: { release?: () => void } = {};
    const baseExec = host.exec.bind(host);
    host.exec = async (cmd: string, execOpts?: { input?: string }) => {
      if (cmd.includes('pkill')) {
        // 进入 kill-and-wait 即翻牌 (baseExec 的记录要等释放后才有,
        // 不能拿 execCalls 当等待信号)。
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
    // 等第一个写完 marker 并卡在 kill-and-wait 阶段。
    await vi.waitFor(() => {
      expect(killStarted).toBe(true);
    });
    const second = reconcileCodexAgentProxyEnv(host).then((r) => {
      order.push('second-done');
      return r;
    });
    // 第二个已入队但不得开工: 给它一拍机会, 确认没有第二个 cat/pkill 发生。
    await Promise.resolve();
    const execCountWhileFirstBlocked = state.execCalls.length;
    await Promise.resolve();
    expect(state.execCalls.length).toBe(execCountWhileFirstBlocked);

    killGate.release?.();
    const [r1, r2] = await Promise.all([first, second]);
    expect(r1.markerChanged).toBe(true);
    expect(r1.daemonRestarted).toBe(true);
    // 第二个在第一个完成后才走对账: 此时 marker 已一致 → fast path 零副作用。
    expect(r2).toEqual({ markerChanged: false, daemonRestarted: false });
    expect(order).toEqual(['first-done', 'second-done']);
    expect(state.pkillCount).toBe(1);
  });
});

describe('applyAgentProxyForHost enable path', () => {
  it('reports apply error and rolls the marker back when the daemon survives pkill (codex R10 P1)', async () => {
    // marker 漂移 (null → 新 proxy marker) 但 pkill 失败: 旧 daemon 还活着跑
    // 旧 env — 不得按成功落 active, 卡片显示错误; marker 回滚到 null 供下次
    // reconcile 重试。
    setSshHostAgentProxy('test-host', PREF);
    const { host, state } = makeFakeHost({ marker: null });
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
    const tunnelState = getAgentProxyTunnelState('test-host');
    expect(tunnelState?.active).toBe(false);
    expect(tunnelState?.lastError).toMatch(/survived pkill/);
    // 原 marker 为 null → 回滚即删除。
    expect(state.marker).toBeNull();
  });
});

describe('ssh-host-prefs-store agentProxy', () => {
  it('round-trips an enabled pref', () => {
    setSshHostAgentProxy('h1', PREF);
    expect(getSshHostAgentProxy('h1')).toEqual(PREF);
  });

  it('returns null for disabled / cleared / unknown hosts', () => {
    setSshHostAgentProxy('h1', { ...PREF, enabled: false });
    expect(getSshHostAgentProxy('h1')).toBeNull();
    setSshHostAgentProxy('h2', PREF);
    setSshHostAgentProxy('h2', null);
    expect(getSshHostAgentProxy('h2')).toBeNull();
    expect(getSshHostAgentProxy('never-set')).toBeNull();
  });

  it('keeps autoConnect when writing agentProxy and vice versa', () => {
    // 双向共存回归 (review: PR #715 五轮审核 P2 — 原测试只写了两次 agentProxy,
    // 没真正交叉 autoConnect): prefs 是同一 JSON 文件里的 sibling 字段,
    // 任一侧写入不得把另一侧冲掉。
    setSshHostAutoConnect('h1', true);
    setSshHostAgentProxy('h1', PREF);
    expect(getSshHostAutoConnect('h1')).toBe(true);
    expect(getSshHostAgentProxy('h1')).toEqual(PREF);
    // 反向: 先写 agentProxy 再改 autoConnect, agentProxy 不丢。
    setSshHostAutoConnect('h1', false);
    expect(getSshHostAgentProxy('h1')).toEqual(PREF);
    expect(getSshHostAutoConnect('h1')).toBe(false);
    // 清 agentProxy 不影响 autoConnect。
    setSshHostAutoConnect('h1', true);
    setSshHostAgentProxy('h1', null);
    expect(getSshHostAgentProxy('h1')).toBeNull();
    expect(getSshHostAutoConnect('h1')).toBe(true);
  });

  it('rejects malformed prefs at write time', () => {
    expect(() =>
      setSshHostAgentProxy('h1', { enabled: true, localHost: 'bad host', localPort: 7890 }),
    ).toThrow(/invalid agentProxy/);
    expect(() =>
      setSshHostAgentProxy('h1', { enabled: true, localPort: 7890, localHost: '127.0.0.1' }),
    ).not.toThrow();
    expect(() =>
      setSshHostAgentProxy('h1', { enabled: true, localHost: '127.0.0.1', localPort: 0 }),
    ).toThrow(/invalid agentProxy/);
    // 引号同样拒 (与 IPC / renderer 校验对齐, review: PR #715 copilot R8)。
    expect(() =>
      setSshHostAgentProxy('h1', { enabled: true, localHost: `12'7.0.0.1`, localPort: 7890 }),
    ).toThrow(/invalid agentProxy/);
    expect(() =>
      setSshHostAgentProxy('h1', { enabled: true, localHost: '12"7.0.0.1', localPort: 7890 }),
    ).toThrow(/invalid agentProxy/);
  });
});
