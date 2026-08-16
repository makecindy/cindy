/**
 * Tests for cleanupRemotePiDaemonsOnHost — the real function from
 * remote-ssh/index.ts (post python daemon retirement, pi-manager is the ONLY
 * daemon). 轮 17 H-2:此前测试的是弱化副本(simulate*), 缺 startedAt/活跃过滤
 * 逻辑 —— 改为 mock 依赖后直接测真实函数, 断言与源码语义一致。
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

const {
  mockPiManagerList,
  mockPiManagerKill,
  mockGetMakerIfReady,
} = vi.hoisted(() => ({
  mockPiManagerList: vi.fn(),
  mockPiManagerKill: vi.fn(),
  mockGetMakerIfReady: vi.fn(),
}));

// 路径相对测试文件(remote-ssh/__tests__ → 上两级 = main/):与 claudeEnv.test.ts
// 的 '../../maker-host/...' 同款解析。vi.mock 解析到真实模块路径后, index.ts
// 里 '../maker-host/...' 的 import 命中同一模块被替换。
vi.mock('../../maker-host/pi-manager-client.js', () => ({
  piManagerList: mockPiManagerList,
  piManagerKill: mockPiManagerKill,
}));

vi.mock('../../maker-host/index.js', () => ({
  getMakerIfReady: mockGetMakerIfReady,
}));

import { cleanupRemotePiDaemonsOnHost } from '../index.js';
import type { RemoteHost } from '@cindy/maker-remote-ssh';

function makeHost(id: string): RemoteHost {
  return { id } as unknown as RemoteHost;
}

// 轮 23-H1 后年龄判断走 daemon 侧算好的 ageMs(本机时钟, 不再跨机器减 epoch);
// 第二个参数即 ageMs —— 缺省 60s(>30s 新生保护阈值, 视为 stale)。
function makeSession(sessionId: string, ageMs = 60_000, lastActivityMs = 2_000_000) {
  return {
    sessionId,
    ageMs,
    startedAt: Date.now(),
    pid: 1,
    sockPath: '/tmp/x',
    envHash: 'h',
    lastActivity: Date.now(),
    // 轮 42 P1:daemon 侧活动时间 —— 缺省 2000s(>30min idle 阈值), 视为可清理;
    // 低于 30min 的会话交给 daemon idle 回收, cleanup 不主动杀。
    lastActivityMs,
    isAttached: false,
  };
}

describe('cleanupRemotePiDaemonsOnHost (real function)', () => {
  const host = makeHost('test-host');

  beforeEach(() => {
    vi.clearAllMocks();
    // 默认:无活跃 maker 会话
    mockGetMakerIfReady.mockReturnValue({ listActiveSessions: () => [] });
  });

  it('no-ops when list returns empty sessions', async () => {
    mockPiManagerList.mockResolvedValue({ sessions: [] });

    await cleanupRemotePiDaemonsOnHost(host);

    expect(mockPiManagerKill).not.toHaveBeenCalled();
    // mock 注入确认:源码的 piManagerList 必须是我们 mock 的 spy
    expect(mockPiManagerList).toHaveBeenCalled();
  });

  it('kills each stale session (older than 30s)', async () => {
    mockPiManagerList.mockResolvedValue({
      sessions: [
        makeSession('old-1', 60_000),
        makeSession('old-2', 120_000),
      ],
    });
    mockPiManagerKill.mockResolvedValue(undefined);

    await cleanupRemotePiDaemonsOnHost(host);

    expect(mockPiManagerKill).toHaveBeenCalledTimes(2);
    expect(mockPiManagerKill).toHaveBeenNthCalledWith(1, host, expect.anything(), 'old-1');
    expect(mockPiManagerKill).toHaveBeenNthCalledWith(2, host, expect.anything(), 'old-2');
  });

  it('skips young sessions (< 30s) — protects sessions still registering (round 12 MEDIUM-4)', async () => {
    mockPiManagerList.mockResolvedValue({
      sessions: [
        makeSession('young-1', 1_000),
        makeSession('old-1', 60_000),
      ],
    });
    mockPiManagerKill.mockResolvedValue(undefined);

    await cleanupRemotePiDaemonsOnHost(host);

    // 只杀 old-1, young-1 被 30s 保护跳过
    expect(mockPiManagerKill).toHaveBeenCalledTimes(1);
    expect(mockPiManagerKill).toHaveBeenCalledWith(host, expect.anything(), 'old-1');
  });

  it('skips sessions active in the local Maker (round 9 HIGH-3 — cross-host kill protection)', async () => {
    mockGetMakerIfReady.mockReturnValue({
      listActiveSessions: () => [{ id: 'active-1', agentKind: 'pi', remoteHostId: 'other-host' }],
    });
    mockPiManagerList.mockResolvedValue({
      sessions: [
        makeSession('active-1', 60_000),
        makeSession('orphan-1', 60_000),
      ],
    });
    mockPiManagerKill.mockResolvedValue(undefined);

    await cleanupRemotePiDaemonsOnHost(host);

    // active-1(本地活跃, 即使属于另一 host 条目共享同一 daemon)跳过, 只杀孤儿
    expect(mockPiManagerKill).toHaveBeenCalledTimes(1);
    expect(mockPiManagerKill).toHaveBeenCalledWith(host, expect.anything(), 'orphan-1');
  });

  it('continues to next session when individual kill fails (best-effort)', async () => {
    mockPiManagerList.mockResolvedValue({
      sessions: [
        makeSession('sess-ok-1', 60_000),
        makeSession('sess-fail', 60_000),
        makeSession('sess-ok-2', 60_000),
      ],
    });
    mockPiManagerKill
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('connection lost'))
      .mockResolvedValueOnce(undefined);

    await cleanupRemotePiDaemonsOnHost(host);

    expect(mockPiManagerKill).toHaveBeenCalledTimes(3);
    // 不抛错 —— best-effort, 失败留日志
  });

  it('catches list failure (best-effort, no throw)', async () => {
    mockPiManagerList.mockRejectedValue(new Error('daemon not running'));

    await expect(cleanupRemotePiDaemonsOnHost(host)).resolves.toBeUndefined();
    expect(mockPiManagerKill).not.toHaveBeenCalled();
  });

  it('skips attached sessions (round 40-w2 HIGH — cross-window kill protection)', async () => {
    // 另一 desktop 窗口正通过 bridge 使用该会话(daemon 侧 attachedSocket 非空),
    // 本窗口的 activePiIds 看不到它 —— isAttached=true 必须跳过, 不能误杀。
    mockPiManagerList.mockResolvedValue({
      sessions: [
        makeSession('attached-other-window', 120_000),
        makeSession('detached-orphan', 120_000),
      ].map((s) => (s.sessionId === 'attached-other-window' ? { ...s, isAttached: true } : s)),
    });
    mockPiManagerKill.mockResolvedValue(undefined);

    await cleanupRemotePiDaemonsOnHost(host);

    // 只杀 detached orphan, attached(被另一窗口使用)跳过
    expect(mockPiManagerKill).toHaveBeenCalledTimes(1);
    expect(mockPiManagerKill).toHaveBeenCalledWith(host, expect.anything(), 'detached-orphan');
  });

  it('skips session with missing ageMs (unknown age — defensive)', async () => {
    // ageMs 缺失(旧 daemon / 畸形 list)→ 不触发 30s 保护也不误杀:
    // 防御分支直接跳过(未知年龄不清理, 由空闲回收兜底)。
    mockPiManagerList.mockResolvedValue({
      sessions: [
        { sessionId: 'no-started', pid: 1, sockPath: '/x', envHash: 'h', lastActivity: Date.now(), isAttached: false } as never,
      ],
    });
    mockPiManagerKill.mockResolvedValue(undefined);

    await cleanupRemotePiDaemonsOnHost(host);

    expect(mockPiManagerKill).not.toHaveBeenCalled();
  });
});
