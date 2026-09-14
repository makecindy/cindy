// @vitest-environment jsdom
/**
 * prRefsGranularity — 真实 PrRefsProvider 的两条回归守卫(2026-08-13 review P1):
 *
 * 1. 订阅粒度:refs 缓存更新只惊动数据真实变化的那一行。此前整张 Map 当
 *    context value,任何会话的 refs 更新都会重渲染全部行(SessionItem 的 memo
 *    挡不住 context 广播);重构为稳定 store + useSyncExternalStore 后,快照
 *    未变的行不重渲染。旧测试(sessionRowRenderIsolation)把 Provider mock 成
 *    稳定空数组,盖不住真实 Provider 的广播行为——本文件用真 Provider。
 *
 * 2. owner 切换的在飞隔离:旧 owner 下发出的远程隧道请求,在响应回来时若 owner
 *    已切换,结果必须整体丢弃(含 TTL 簿记),不能污染新 owner 的共享缓存。
 */

import { act, render, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SessionPrRef } from '@/lib/gitContext.types';

// 可变 owner:测试内切换后 rerender 即生效。
let mockOwner: string | null = 'owner-1';
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ dataOwnerId: mockOwner }),
}));

import {
  PrRefsProvider,
  usePrActions,
  usePrRefsForSession,
  usePrStatus,
} from '@/contexts/PrRefsContext';

function makeRef(sessionId: string, prNumber: number): SessionPrRef {
  return {
    id: `ref-${sessionId}-${prNumber}`,
    sessionId,
    owner: 'octo',
    repo: 'repo',
    prNumber,
    url: `https://github.com/octo/repo/pull/${prNumber}`,
    firstSeenAt: 1,
    lastSeenAt: 2,
  };
}

interface GitContextMock {
  listAllPrRefs: ReturnType<typeof vi.fn>;
  listPrRefs: ReturnType<typeof vi.fn>;
  getPrStatuses: ReturnType<typeof vi.fn>;
  onPrRefsChanged: ReturnType<typeof vi.fn>;
}

function installElectronApi(): {
  gitContext: GitContextMock;
  invoke: ReturnType<typeof vi.fn>;
  emitPrRefsChanged: (sessionId: string) => void;
} {
  let changedCb: ((data: { sessionId: string }) => void) | null = null;
  const gitContext: GitContextMock = {
    listAllPrRefs: vi.fn().mockResolvedValue([]),
    listPrRefs: vi.fn().mockResolvedValue([]),
    getPrStatuses: vi.fn().mockResolvedValue([]),
    onPrRefsChanged: vi.fn((cb: (data: { sessionId: string }) => void) => {
      changedCb = cb;
      return () => undefined;
    }),
  };
  const invoke = vi.fn();
  window.electronAPI = { gitContext, deviceLink: { invoke } } as never;
  return {
    gitContext,
    invoke,
    emitPrRefsChanged: (sessionId) => changedCb?.({ sessionId }),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  mockOwner = 'owner-1';
});

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(PrRefsProvider, null, children);

describe('PrRefsProvider 订阅粒度(真实 Provider)', () => {
  it('某会话 refs 更新只重渲染该会话的订阅行,其它行不醒', async () => {
    const api = installElectronApi();
    api.gitContext.listPrRefs.mockImplementation(async (sessionId: string) =>
      sessionId === 'session-a' ? [makeRef('session-a', 7)] : [],
    );

    let rendersA = 0;
    let rendersB = 0;
    let latestA: SessionPrRef[] = [];
    function ProbeA() {
      rendersA += 1;
      latestA = usePrRefsForSession('session-a');
      return null;
    }
    function ProbeB() {
      rendersB += 1;
      usePrRefsForSession('session-b');
      return null;
    }
    render(createElement(PrRefsProvider, null, createElement(ProbeA), createElement(ProbeB)));
    await waitFor(() => expect(api.gitContext.listAllPrRefs).toHaveBeenCalled());
    const initialB = rendersB;

    // session-a 的引用变化推送 → A 拿到数据;B 的快照(空数组常量)未变,不重渲染。
    act(() => api.emitPrRefsChanged('session-a'));
    await waitFor(() => expect(latestA).toHaveLength(1));
    expect(rendersB).toBe(initialB);

    // 同内容再推一次:store 比对后不通知,连 A 都不重渲染。
    const rendersAAfterFirst = rendersA;
    act(() => api.emitPrRefsChanged('session-a'));
    await waitFor(() => expect(api.gitContext.listPrRefs).toHaveBeenCalledTimes(2));
    expect(rendersA).toBe(rendersAAfterFirst);
    expect(rendersB).toBe(initialB);
  });
});

describe('PrRefsProvider owner 切换的在飞隔离', () => {
  it('旧 owner 的远程 refs 响应在 owner 切换后被整体丢弃', async () => {
    const api = installElectronApi();
    let resolveInvoke: ((value: SessionPrRef[]) => void) | null = null;
    api.invoke.mockImplementation(
      (_deviceId: string, channel: string) =>
        new Promise((resolve) => {
          if (channel === 'git-context:pr-refs:list') resolveInvoke = resolve as never;
        }),
    );

    mockOwner = 'owner-1';
    const { result, rerender } = renderHook(
      () => {
        const { registerPrConsumer } = usePrActions();
        const refs = usePrRefsForSession('session-r');
        return { registerPrConsumer, refs };
      },
      { wrapper },
    );
    // 注册远程消费者 → 发出隧道 refs 拉取(挂起中)。
    act(() => {
      result.current.registerPrConsumer('session-r', 'device-1');
    });
    await waitFor(() =>
      expect(api.invoke).toHaveBeenCalledWith('device-1', 'git-context:pr-refs:list', [
        'session-r',
      ]),
    );

    // 响应回来前切换 owner。
    mockOwner = 'owner-2';
    rerender();

    // 旧 owner 的响应此刻才到 → 必须被丢弃,新 owner 缓存保持为空。
    await act(async () => {
      resolveInvoke?.([makeRef('session-r', 42)]);
      await Promise.resolve();
    });
    expect(result.current.refs).toEqual([]);
  });

  // 复核 P1:在飞去重表必须带代数——旧 owner 的状态请求可能要等超时(远程默认
  // ~30s)才 settle,裸集合会让新 owner 的首查被旧 owner 的尸体挡住。
  it('旧 owner 挂起中的状态请求不挡新 owner 的首查,其迟到结果被丢弃', async () => {
    const api = installElectronApi();
    const ref = makeRef('session-s', 9);
    api.gitContext.listAllPrRefs.mockResolvedValue([ref]);
    const pending: Array<(value: unknown) => void> = [];
    api.gitContext.getPrStatuses.mockImplementation(
      () =>
        new Promise((resolve) => {
          pending.push(resolve as (value: unknown) => void);
        }),
    );

    mockOwner = 'owner-1';
    const { result, rerender } = renderHook(
      () => {
        const { registerPrConsumer } = usePrActions();
        const status = usePrStatus('session-s', 'octo/repo#9');
        return { registerPrConsumer, status };
      },
      { wrapper },
    );
    act(() => {
      result.current.registerPrConsumer('session-s');
    });
    // 全量加载到位后对已注册消费者发起首查(旧 owner,挂起不返回)。
    await waitFor(() => expect(api.gitContext.getPrStatuses).toHaveBeenCalledTimes(1));

    // 切 owner:effect 重跑 → 全量加载 → 对同一会话再次发起状态查询。
    // 若在飞表不带代数,这次首查会被旧请求挡住(P1 的症状)。
    mockOwner = 'owner-2';
    rerender();
    await waitFor(() => expect(api.gitContext.getPrStatuses).toHaveBeenCalledTimes(2));

    // 新代结果落库;旧代迟到结果被代数丢弃,不得覆盖。
    const newResult = { ok: true, owner: 'octo', repo: 'repo', prNumber: 9, status: 'open' };
    const staleResult = { ok: true, owner: 'octo', repo: 'repo', prNumber: 9, status: 'merged' };
    await act(async () => {
      pending[1]?.([newResult]);
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.status).toMatchObject({ status: 'open' }));
    await act(async () => {
      pending[0]?.([staleResult]);
      await Promise.resolve();
    });
    expect(result.current.status).toMatchObject({ status: 'open' });
  });

  it('本机已注册会话在全表缓存未命中时按会话补拉引用', async () => {
    const api = installElectronApi();
    const ref = makeRef('session-local', 11);
    // 模拟 listAllPrRefs 的 2000 行上限把该会话截掉。
    api.gitContext.listAllPrRefs.mockResolvedValue([]);
    api.gitContext.listPrRefs.mockImplementation(async (sessionId: string) =>
      sessionId === 'session-local' ? [ref] : [],
    );

    const { result } = renderHook(
      () => {
        const { registerPrConsumer } = usePrActions();
        const refs = usePrRefsForSession('session-local');
        return { registerPrConsumer, refs };
      },
      { wrapper },
    );
    act(() => {
      result.current.registerPrConsumer('session-local');
    });

    await waitFor(() => expect(api.gitContext.listPrRefs).toHaveBeenCalledWith('session-local'));
    await waitFor(() => expect(result.current.refs).toHaveLength(1));
    await waitFor(() => expect(api.gitContext.getPrStatuses).toHaveBeenCalled());
    // 全表后到时不得把按会话结果冲掉;否则 TTL 会压住约 85s。
    expect(result.current.refs).toHaveLength(1);
    expect(api.gitContext.listPrRefs).toHaveBeenCalledTimes(1);
  });

  it('全表后到时保住先返回的本机按会话引用', async () => {
    const api = installElectronApi();
    const ref = makeRef('session-local', 12);
    let resolveAll: ((value: SessionPrRef[]) => void) | null = null;
    api.gitContext.listAllPrRefs.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveAll = resolve as (value: SessionPrRef[]) => void;
        }),
    );
    api.gitContext.listPrRefs.mockImplementation(async (sessionId: string) =>
      sessionId === 'session-local' ? [ref] : [],
    );

    const { result } = renderHook(
      () => {
        const { registerPrConsumer } = usePrActions();
        const refs = usePrRefsForSession('session-local');
        return { registerPrConsumer, refs };
      },
      { wrapper },
    );
    act(() => {
      result.current.registerPrConsumer('session-local');
    });
    await waitFor(() => expect(result.current.refs).toHaveLength(1));

    await act(async () => {
      resolveAll?.([]);
      await Promise.resolve();
    });
    expect(result.current.refs).toHaveLength(1);
    expect(api.gitContext.listPrRefs).toHaveBeenCalledTimes(1);
  });
});
