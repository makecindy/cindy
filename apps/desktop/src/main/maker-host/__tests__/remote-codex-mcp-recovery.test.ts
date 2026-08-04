/**
 * remote-codex-mcp-recovery 测试:bridge 重建后的恢复遍历 — host 过滤、
 * checker 未装配不触发、ensure 参数、失败记 warn。
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { RemoteHost } from '@cindy/maker-remote-ssh';

vi.mock('../../remote-ssh/codex-remote-mcp.js', () => ({
  ensureRemoteCodexMcpBridge: vi.fn(async () => ({ ok: true, daemonRebootstrapped: true })),
}));

import {
  refreshRemoteCodexMcpAfterBridgeRecreate,
  invalidateRemoteCcQueriesForMcpGenerationChange,
  maybeDetachStaleRemoteCcQuery,
} from '../remote-codex-mcp-recovery.js';
import { ensureRemoteCodexMcpBridge } from '../../remote-ssh/codex-remote-mcp.js';

const ensureMock = vi.mocked(ensureRemoteCodexMcpBridge);

function host(id: string): RemoteHost {
  return { id } as unknown as RemoteHost;
}

function makeDeps(overrides?: Partial<Parameters<typeof refreshRemoteCodexMcpAfterBridgeRecreate>[0]>) {
  const warn = vi.fn();
  const checker = vi.fn((_hostId: string): boolean => false);
  const deps = {
    listRemoteCodexHostIds: () => ['host-a', 'host-b'],
    getReadyHost: (id: string) => host(id),
    ensureBridgeStarted: async () => ({ port: 38080, serverNames: ['cindy_orca'], bridgeInstanceId: 'bridge-2' }),
    getLiveTurnChecker: () => checker,
    isCollabEnabled: () => true,
    isMakerMemoryEnabled: () => false,
    detachRemoteCodexSessionsOnHost: vi.fn(),
    log: { warn },
    ...overrides,
  };
  return { deps, warn, checker };
}

describe('refreshRemoteCodexMcpAfterBridgeRecreate', () => {
  beforeEach(() => {
    ensureMock.mockClear();
    ensureMock.mockResolvedValue({ ok: true, daemonRebootstrapped: true });
  });

  it('ensures every active remote codex host with the shared live-turn checker', () => {
    const { deps, checker } = makeDeps();
    refreshRemoteCodexMcpAfterBridgeRecreate(deps);
    expect(ensureMock).toHaveBeenCalledTimes(2);
    for (const [callHost, callDeps] of ensureMock.mock.calls) {
      expect(['host-a', 'host-b']).toContain(callHost.id);
      expect(callDeps.ensureBridgeStarted).toBe(deps.ensureBridgeStarted);
      expect(callDeps.hasLiveTurnOnHost).toBe(checker);
      // R21 P1: 恢复路径必须透传 Collab 闸门 — 禁用时 ensure 走清理而非重注入。
      expect(callDeps.isCollabEnabled).toBe(deps.isCollabEnabled);
      // Maker Memory 同源闸门:缺省 false 会让补刀把已注入的 cindy_memory 剥掉。
      expect(callDeps.isMakerMemoryEnabled).toBe(deps.isMakerMemoryEnabled);
    }
  });

  it('skips hosts that are not ready', () => {
    const { deps } = makeDeps({
      getReadyHost: (id) => (id === 'host-a' ? host(id) : null),
    });
    refreshRemoteCodexMcpAfterBridgeRecreate(deps);
    expect(ensureMock).toHaveBeenCalledTimes(1);
    expect(ensureMock.mock.calls[0][0].id).toBe('host-a');
  });

  it('does nothing when the live-turn checker is not wired (never kills a turn by mistake)', () => {
    const { deps } = makeDeps({ getLiveTurnChecker: () => null });
    refreshRemoteCodexMcpAfterBridgeRecreate(deps);
    expect(ensureMock).not.toHaveBeenCalled();
  });

  it('detaches active codex sessions on the host after a successful rebootstrap (R26 P1)', async () => {
    // ensure 成功且非 live-turn defer ⇒ daemon 已重启 ⇒ 旧 transport 死 —
    // 必须 detach 让下次 send 走 lazy-resume, 否则 idle-live send 看到
    // drift 已清会把消息送进死 channel。
    const { deps, checker } = makeDeps();
    const detachMock = deps.detachRemoteCodexSessionsOnHost as ReturnType<typeof vi.fn>;
    refreshRemoteCodexMcpAfterBridgeRecreate(deps);
    await vi.waitFor(() => {
      expect(detachMock).toHaveBeenCalledWith('host-a');
      expect(detachMock).toHaveBeenCalledWith('host-b');
    });
    expect(checker).toHaveBeenCalled();
  });

  it('does not detach when a live turn deferred the rebootstrap (daemon still running the old socket)', async () => {
    const { deps } = makeDeps({ getLiveTurnChecker: () => () => true });
    const detachMock = deps.detachRemoteCodexSessionsOnHost as ReturnType<typeof vi.fn>;
    refreshRemoteCodexMcpAfterBridgeRecreate(deps);
    await vi.waitFor(() => {
      expect(ensureMock).toHaveBeenCalledTimes(2);
    });
    expect(detachMock).not.toHaveBeenCalled();
  });

  it('does not detach when ensure succeeds without rebootstrap (transport is still valid)', async () => {
    ensureMock.mockResolvedValue({ ok: true, daemonRebootstrapped: false });
    const { deps } = makeDeps({ listRemoteCodexHostIds: () => ['host-a'] });
    const detachMock = deps.detachRemoteCodexSessionsOnHost as ReturnType<typeof vi.fn>;
    refreshRemoteCodexMcpAfterBridgeRecreate(deps);
    await vi.waitFor(() => {
      expect(ensureMock).toHaveBeenCalledTimes(1);
    });
    expect(detachMock).not.toHaveBeenCalled();
  });

  it('does not detach when the ensure fails (no rebootstrap happened)', async () => {
    ensureMock.mockResolvedValue({ ok: false, reason: 'forward-failed' });
    const { deps } = makeDeps({ listRemoteCodexHostIds: () => ['host-a'] });
    const detachMock = deps.detachRemoteCodexSessionsOnHost as ReturnType<typeof vi.fn>;
    refreshRemoteCodexMcpAfterBridgeRecreate(deps);
    await vi.waitFor(() => {
      expect(ensureMock).toHaveBeenCalledTimes(1);
    });
    expect(detachMock).not.toHaveBeenCalled();
  });

  it('logs a warning instead of throwing when an ensure reports failure', async () => {
    ensureMock.mockResolvedValue({ ok: false, reason: 'forward-failed' });
    const { deps, warn } = makeDeps({ listRemoteCodexHostIds: () => ['host-a'] });
    refreshRemoteCodexMcpAfterBridgeRecreate(deps);
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith(
        'remote MCP recovery after bridge recreate failed',
        expect.objectContaining({ hostId: 'host-a', reason: 'forward-failed' }),
      );
    });
  });

  it('logs and absorbs unexpected ensure rejections', async () => {
    ensureMock.mockRejectedValue(new Error('ssh closed'));
    const { deps, warn } = makeDeps({ listRemoteCodexHostIds: () => ['host-a'] });
    refreshRemoteCodexMcpAfterBridgeRecreate(deps);
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith(
        'remote MCP recovery after bridge recreate threw',
        expect.objectContaining({ hostId: 'host-a', reason: 'ssh closed' }),
      );
    });
  });
});

describe('invalidateRemoteCcQueriesForMcpGenerationChange', () => {
  function ccSession(id: string, remoteHostId: string | null, running = false) {
    return {
      id,
      remoteHostId,
      isTurnRunning: () => running,
      detach: vi.fn(async () => {}),
    };
  }

  it('clears fresh marks and detaches idle remote CC queries; skips running turns without detaching', () => {
    const idle = ccSession('cc-1', 'host-a');
    const running = ccSession('cc-2', 'host-a', true);
    const local = ccSession('cc-3', null);
    const cleared: string[] = [];
    invalidateRemoteCcQueriesForMcpGenerationChange(
      {
        listRemoteCcSessions: () => [idle, running, local],
        clearFreshMark: (id) => cleared.push(id),
        log: { warn: vi.fn() },
      },
      { reason: 'bridge-recreate' },
    );
    expect(cleared).toEqual(['cc-1', 'cc-2']);
    expect(idle.detach).toHaveBeenCalledTimes(1);
    expect(running.detach).not.toHaveBeenCalled();
    expect(local.detach).not.toHaveBeenCalled();
  });

  it('scopes invalidation to the given hostId (forward rearm affects one host)', () => {
    const onA = ccSession('cc-1', 'host-a');
    const onB = ccSession('cc-2', 'host-b');
    const cleared: string[] = [];
    invalidateRemoteCcQueriesForMcpGenerationChange(
      {
        listRemoteCcSessions: () => [onA, onB],
        clearFreshMark: (id) => cleared.push(id),
        log: { warn: vi.fn() },
      },
      { hostId: 'host-a', reason: 'forward-rearmed' },
    );
    expect(cleared).toEqual(['cc-1']);
    expect(onA.detach).toHaveBeenCalledTimes(1);
    expect(onB.detach).not.toHaveBeenCalled();
  });
});

describe('maybeDetachStaleRemoteCcQuery', () => {
  it('detaches only when the session was explicitly invalidated (stale mark) and no turn is running', () => {
    const s = { id: 'cc-1', remoteHostId: 'host-a', isTurnRunning: () => false, detach: vi.fn(async () => {}) };
    maybeDetachStaleRemoteCcQuery(
      { getSession: () => s, hasStaleMark: () => true, log: { warn: vi.fn() } },
      'cc-1',
    );
    expect(s.detach).toHaveBeenCalledTimes(1);
  });

  it('is a no-op for healthy sessions without a stale mark (never-fresh is not stale), local sessions, and running turns', () => {
    const fresh = { id: 'cc-1', remoteHostId: 'host-a', isTurnRunning: () => false, detach: vi.fn(async () => {}) };
    maybeDetachStaleRemoteCcQuery(
      { getSession: () => fresh, hasStaleMark: () => false, log: { warn: vi.fn() } },
      'cc-1',
    );
    expect(fresh.detach).not.toHaveBeenCalled();

    const local = { id: 'cc-2', remoteHostId: null, isTurnRunning: () => false, detach: vi.fn(async () => {}) };
    maybeDetachStaleRemoteCcQuery(
      { getSession: () => local, hasStaleMark: () => true, log: { warn: vi.fn() } },
      'cc-2',
    );
    expect(local.detach).not.toHaveBeenCalled();

    const running = { id: 'cc-3', remoteHostId: 'host-a', isTurnRunning: () => true, detach: vi.fn(async () => {}) };
    maybeDetachStaleRemoteCcQuery(
      { getSession: () => running, hasStaleMark: () => true, log: { warn: vi.fn() } },
      'cc-3',
    );
    expect(running.detach).not.toHaveBeenCalled();
  });
});
