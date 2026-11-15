// @vitest-environment jsdom
/**
 * 测试价值
 * - 生产入口与可观察结果：`useStopOrcaCollab().requestStop`（普通 Lead 路由的「结束协同」入口，
 *   CCAgentSessionView 在该路由上不传 orcaMode，navigateOnSuccess 落到默认值 true）；
 *   用户已离开 Lead 时断言 HashRouter 的当前页面不被改写；仍停在该 Lead 的地址上（旧协同
 *   路由 /cc-agent/orca/<lead>）时断言仍回到普通 Lead 路由，跟转判断两侧的改坏都会被发现。
 * - Bug／规则依据：结束协同要等 Worker worktree 回收（实测数秒到数十秒，未提交文件越多越久），
 *   期间用户点「新建」、切到其他任务、打开同一任务的文件页或删除 Lead，请求完成后页面仍被 replace 回 Lead。
 * - 现有覆盖缺口：此前没有任何测试覆盖结束协同完成后的跳转；相邻的
 *   useSessionLifecycleActions.test.tsx 测的是另一个 hook，且 mock 掉了 useNavigate 与
 *   sessionsStore（形状不同），并入会让两边互相牵制，故单独成文件。
 *   原有用例未覆盖等待期间打开同一任务文件页的情况，无法发现复用删除/归档路由判据导致的误跳转。
 * - 最小失败输入：disableOrca 挂起 → 路由切到其他页面（含同一任务的文件页）→ disableOrca 完成；以及停在
 *   /cc-agent/orca/<lead> → disableOrca 完成（判断恒为 false 时失败）。注意当前 /cc-agent/orca/:id
 *   只是兼容转发页，CCAgentSessionView 不会停在该地址，这条守的是 hook 自身的跳转约定。
 * - tier：unit（jsdom + 真实 HashRouter，其余依赖进程内 fake）。
 */

import { transferableAbortController } from 'node:util';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RouterProvider, createHashRouter } from 'react-router-dom';

const mocks = vi.hoisted(() => ({
  disableOrca: vi.fn(),
  confirm: vi.fn(),
  forceRefresh: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: mocks.confirm }),
}));

vi.mock('@/lib/makerTransport', () => ({
  makerApiForSticky: () => ({ disableOrca: mocks.disableOrca }),
}));

vi.mock('@/lib/sessionsStore', () => ({
  sessionsStore: { forceRefresh: mocks.forceRefresh },
}));

vi.mock('@/lib/toast', () => ({
  toast: { error: vi.fn() },
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { useStopOrcaCollab, type StopOrcaCollabApi } from '../useStopOrcaCollab';

const LEAD_ID = 'lead-1';
const routers: Array<ReturnType<typeof createHashRouter>> = [];

// React Router 的 Node 原生 Request 要求原生 AbortSignal（新版 Node 下 jsdom 的不满足），
// 与 sessionEntryLocationCommits.test.tsx 同一处理。
const nativeAbortController = transferableAbortController();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('AbortController', nativeAbortController.constructor);
  vi.stubGlobal('AbortSignal', nativeAbortController.signal.constructor);
  mocks.confirm.mockResolvedValue(true);
  window.history.replaceState(null, '', `#/cc-agent/${LEAD_ID}`);
});

afterEach(() => {
  cleanup();
  for (const router of routers.splice(0)) router.dispose();
  vi.unstubAllGlobals();
});

function renderLeadRoute() {
  const api: { current: StopOrcaCollabApi | null } = { current: null };
  function LeadRouteProbe() {
    // 与 CCAgentSessionView 普通路由一致：不显式传 navigateOnSuccess。
    api.current = useStopOrcaCollab({ leadSessionId: LEAD_ID });
    return null;
  }
  const router = createHashRouter([{ path: '*', element: <LeadRouteProbe /> }]);
  routers.push(router);
  render(<RouterProvider router={router} />);
  return { router, api };
}

describe('useStopOrcaCollab navigation after disableOrca', () => {
  it.each([
    ['新建任务页', '/cc-agent/new'],
    ['其他任务', '/cc-agent/other-task'],
    ['同一任务的文件页', `/cc-agent/files/${LEAD_ID}`],
  ])('keeps the page the user moved to (%s) while the stop request was pending', async (_label, route) => {
    let finishDisable!: (value: { ok: true }) => void;
    mocks.disableOrca.mockReturnValue(
      new Promise<{ ok: true }>((resolve) => {
        finishDisable = resolve;
      }),
    );
    const { router, api } = renderLeadRoute();

    let stopped!: Promise<boolean>;
    await act(async () => {
      stopped = api.current!.requestStop();
      await vi.waitFor(() => expect(mocks.disableOrca).toHaveBeenCalledWith(LEAD_ID));
    });

    await act(async () => {
      await router.navigate(route);
    });
    await act(async () => {
      finishDisable({ ok: true });
      await expect(stopped).resolves.toBe(true);
    });

    expect(router.state.location.pathname).toBe(route);
    expect(window.location.hash).toBe(`#${route}`);
  });

  it('still returns to the plain Lead route when the user stayed on that Lead', async () => {
    window.history.replaceState(null, '', `#/cc-agent/orca/${LEAD_ID}`);
    mocks.disableOrca.mockResolvedValue({ ok: true });
    const { router, api } = renderLeadRoute();

    await act(async () => {
      await expect(api.current!.requestStop()).resolves.toBe(true);
    });

    expect(router.state.location.pathname).toBe(`/cc-agent/${LEAD_ID}`);
  });
});
