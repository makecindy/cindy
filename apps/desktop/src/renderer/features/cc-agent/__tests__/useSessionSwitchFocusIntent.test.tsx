// @vitest-environment jsdom
import { act, cleanup, fireEvent, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  queryHostPendingPermissions,
  useSessionSwitchFocusIntent,
  type HostPendingPermission,
  type QueryPendingPermissions,
} from '../useSessionSwitchFocusIntent';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

interface Props {
  sessionId: string | undefined;
  enabled: boolean;
  pending?: string | null;
  query?: QueryPendingPermissions | null;
}

// 默认：本地已经展示着切换时挂起的请求 p1，Host 查询不会被用到。
const noQuery: QueryPendingPermissions = () => Promise.resolve([]);

function setup(initial: Props) {
  return renderHook(
    ({ sessionId, enabled, pending = 'p1', query = noQuery }: Props) =>
      useSessionSwitchFocusIntent(sessionId, enabled, pending, query ?? null),
    { initialProps: initial },
  );
}

/**
 * 可以在测试里手动结算的 Host 查询。只给 id 时按「切换前很久就已挂起」上报时长；
 * 也可以直接给出 Host 报的完整条目。
 */
function deferredQuery() {
  let resolve!: (list: readonly HostPendingPermission[]) => void;
  const query = vi.fn(
    () =>
      new Promise<readonly HostPendingPermission[]>((r) => {
        resolve = r;
      }),
  );
  return {
    query,
    resolve: (items: ReadonlyArray<string | HostPendingPermission>) =>
      resolve(items.map((i) => (typeof i === 'string' ? { requestId: i, pendingForMs: 60_000 } : i))),
  };
}

/** 让 performance.now() 可控：切换（hook 挂载）发生在 1000ms。 */
function controlClock() {
  let now = 1000;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  return { advance: (ms: number) => (now += ms) };
}

describe('useSessionSwitchFocusIntent', () => {
  it('首次打开任务即武装，消费后不再武装', () => {
    const { result } = setup({ sessionId: 'a', enabled: true });
    expect(result.current.armed).toBe(true);
    act(() => result.current.consume());
    expect(result.current.armed).toBe(false);
  });

  it('切换到另一个任务时重新武装', () => {
    const { result, rerender } = setup({ sessionId: 'a', enabled: true });
    act(() => result.current.consume());
    rerender({ sessionId: 'b', enabled: true });
    expect(result.current.armed).toBe(true);
  });

  it('同一任务内重渲染不会重新武装', () => {
    const { result, rerender } = setup({ sessionId: 'a', enabled: true });
    act(() => result.current.consume());
    rerender({ sessionId: 'a', enabled: true });
    expect(result.current.armed).toBe(false);
  });

  it('切换后用户点击或按键即撤销，晚到的请求不抢焦点', () => {
    const { result, rerender } = setup({ sessionId: 'a', enabled: true });
    act(() => fireEvent.pointerDown(window));
    expect(result.current.armed).toBe(false);
    rerender({ sessionId: 'b', enabled: true });
    expect(result.current.armed).toBe(true);
    act(() => fireEvent.keyDown(window, { key: 'a' }));
    expect(result.current.armed).toBe(false);
  });

  // 键盘切换：切换用的 Enter 还按着，确认卡要等历史重建后才出现。期间的自动重复不是
  // 新操作，不能撤销意图；用户真正新按一个键才撤销。
  it('切换时仍按着的 Enter / 空格产生的重复不撤销意图', () => {
    const { result } = setup({ sessionId: 'a', enabled: true });
    act(() => fireEvent.keyDown(window, { key: 'Enter', repeat: true }));
    act(() => fireEvent.keyDown(window, { key: ' ', repeat: true }));
    expect(result.current.armed).toBe(true);
    act(() => fireEvent.keyDown(window, { key: 'Enter' }));
    expect(result.current.armed).toBe(false);
  });

  // 读屏等辅助技术激活控件时只发一次可信 click，没有 pointerdown / keydown。jsdom 造不出
  // isTrusted=true 的事件，所以取到真实挂上的 click 监听，直接按可信与否各调一次。
  it('辅助技术的可信 click 撤销意图，代码里的 .click() 不撤销', () => {
    const add = vi.spyOn(window, 'addEventListener');
    const { result } = setup({ sessionId: 'a', enabled: true });
    const clickListener = add.mock.calls.find(([type]) => type === 'click')?.[1] as
      | ((e: Pick<MouseEvent, 'isTrusted'>) => void)
      | undefined;
    expect(clickListener).toBeTypeOf('function');

    act(() => fireEvent.click(document.body));
    expect(result.current.armed).toBe(true);
    act(() => clickListener?.({ isTrusted: false }));
    expect(result.current.armed).toBe(true);
    act(() => clickListener?.({ isTrusted: true }));
    expect(result.current.armed).toBe(false);
  });

  // 新窗口 / 刷新后切到任务：本地挂起请求还没重建、活动快照也可能是空的。这时向 Host
  // 查一次，查到的请求随后在本地出现时照常聚焦。
  it('本地还没重建时向 Host 查询，切换时已挂起的请求随后出现仍会聚焦', async () => {
    const { query, resolve } = deferredQuery();
    const { result, rerender } = setup({ sessionId: 'a', enabled: true, pending: null, query });
    expect(query).toHaveBeenCalledWith('a');
    await act(async () => resolve(['p1']));
    expect(result.current.armed).toBe(false);
    rerender({ sessionId: 'a', enabled: true, pending: 'p1', query });
    expect(result.current.armed).toBe(true);
  });

  it('查询结果晚于本地重建也会聚焦', async () => {
    const { query, resolve } = deferredQuery();
    const { result, rerender } = setup({ sessionId: 'a', enabled: true, pending: null, query });
    rerender({ sessionId: 'a', enabled: true, pending: 'p1', query });
    expect(result.current.armed).toBe(false);
    await act(async () => resolve(['p1']));
    expect(result.current.armed).toBe(true);
  });

  // 切到一个还在跑、没在等授权的任务，用户只是看输出；之后才弹出的新请求不是这次切换要
  // 交接的，不能把焦点从侧栏行抢走（那时回车就成了批准）。
  it.each([
    ['Host 上没有挂起请求', (() => Promise.resolve([])) as QueryPendingPermissions],
    ['查询失败', (() => Promise.reject(new Error('offline'))) as QueryPendingPermissions],
  ])('切换时没在等授权（%s），之后才到的新请求不抢焦点', async (_name, query) => {
    const { result, rerender } = setup({ sessionId: 'a', enabled: true, pending: null, query });
    await act(async () => {});
    rerender({ sessionId: 'a', enabled: true, pending: 'p1', query });
    expect(result.current.armed).toBe(false);
  });

  // 切换时在等 p1，确认卡重建前 p1 被别处处理掉、p2 顶上来；会话一直是「等授权」，但 p2
  // 不是这次切换要交接的请求。
  it('交接的请求被别的请求替换后不抢焦点', () => {
    const { result, rerender } = setup({ sessionId: 'a', enabled: true, pending: 'p1' });
    expect(result.current.armed).toBe(true);
    rerender({ sessionId: 'a', enabled: true, pending: 'p2' });
    expect(result.current.armed).toBe(false);
  });

  // Host 快照是查询执行那一刻的实时读取。远程往返 800ms 期间 Host 新建了 p2：它报的
  // 已挂起时长（300ms）短于切换到收到结果的时间，说明是切换之后才建的，不能接管焦点，
  // 否则下一次回车就批准了一个切换时还不存在的请求。切换前就在等的 p1 照常交接。
  it('只接受切换前就已挂起的请求，查询途中新建的不抢焦点', async () => {
    const clock = controlClock();
    const { query, resolve } = deferredQuery();
    const { result, rerender } = setup({ sessionId: 'a', enabled: true, pending: null, query });
    clock.advance(800);
    await act(async () =>
      resolve([
        { requestId: 'p1', pendingForMs: 5_000 },
        { requestId: 'p2', pendingForMs: 300 },
      ]),
    );
    rerender({ sessionId: 'a', enabled: true, pending: 'p2', query });
    expect(result.current.armed).toBe(false);
    rerender({ sessionId: 'a', enabled: true, pending: 'p1', query });
    expect(result.current.armed).toBe(true);
  });

  // 旧被控端不报时长：分不清请求是切换前还是查询途中建的，按不确定处理。
  it('Host 没报挂起时长（旧版本）时不聚焦', async () => {
    const { query, resolve } = deferredQuery();
    const { result, rerender } = setup({ sessionId: 'a', enabled: true, pending: null, query });
    await act(async () => resolve([{ requestId: 'p1' }]));
    rerender({ sessionId: 'a', enabled: true, pending: 'p1', query });
    expect(result.current.armed).toBe(false);
  });

  // 远程任务刷新后，设备镜像还没填充，归属未知（query 为 null）。这时不能去问本机
  // （本机列表为空，意图会被直接清掉）；归属解析后再查，切换前就在等的请求照常聚焦。
  it('归属解析前不查询，解析后再查', async () => {
    const { query, resolve } = deferredQuery();
    const { result, rerender } = setup({ sessionId: 'a', enabled: true, pending: null, query: null });
    await act(async () => {});
    expect(query).not.toHaveBeenCalled();
    rerender({ sessionId: 'a', enabled: true, pending: null, query });
    expect(query).toHaveBeenCalledWith('a');
    await act(async () => resolve(['p1']));
    rerender({ sessionId: 'a', enabled: true, pending: 'p1', query });
    expect(result.current.armed).toBe(true);
  });

  it('查询结果回来前用户已有操作，结果作废', async () => {
    const { query, resolve } = deferredQuery();
    const { result, rerender } = setup({ sessionId: 'a', enabled: true, pending: null, query });
    act(() => fireEvent.pointerDown(window));
    await act(async () => resolve(['p1']));
    rerender({ sessionId: 'a', enabled: true, pending: 'p1', query });
    expect(result.current.armed).toBe(false);
  });

  it('未启用（分屏非主 pane、只读等）时从不武装', () => {
    const { result, rerender } = setup({ sessionId: 'a', enabled: false });
    expect(result.current.armed).toBe(false);
    rerender({ sessionId: 'b', enabled: false });
    expect(result.current.armed).toBe(false);
  });

  // 分屏里已挂载的 pane 被选中成为主视图：sessionId 不变，只有 enabled false → true。
  it('同一任务的视图重新成为主视图时重新武装', () => {
    const { result, rerender } = setup({ sessionId: 'a', enabled: true });
    act(() => result.current.consume());
    rerender({ sessionId: 'a', enabled: false });
    expect(result.current.armed).toBe(false);
    rerender({ sessionId: 'a', enabled: true });
    expect(result.current.armed).toBe(true);
  });
});

// 查询入口按已解析的归属选 Host，并要求 Host 带上挂起时长；只取授权请求。
describe('queryHostPendingPermissions', () => {
  const snapshot = [
    { request: { kind: 'permission', requestId: 'p1' }, pendingForMs: 4200 },
    { request: { kind: 'ask_user_question', requestId: 'q1' }, pendingForMs: 4200 },
    { request: { kind: 'permission', requestId: 'p-old-host' } },
  ];
  const expected = [{ requestId: 'p1', pendingForMs: 4200 }, { requestId: 'p-old-host' }];

  afterEach(() => {
    delete (window as { electronAPI?: unknown }).electronAPI;
  });

  it('本机任务问本机 Host', async () => {
    const getPendingInteractions = vi.fn(async () => snapshot);
    const invoke = vi.fn();
    Object.assign(window, { electronAPI: { maker: { getPendingInteractions }, deviceLink: { invoke } } });
    await expect(queryHostPendingPermissions(null, 's1')).resolves.toEqual(expected);
    expect(getPendingInteractions).toHaveBeenCalledWith('s1', { includeAge: true });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('远程任务经 Device Link 问它所在的被控端', async () => {
    const getPendingInteractions = vi.fn();
    const invoke = vi.fn(async () => snapshot);
    Object.assign(window, { electronAPI: { maker: { getPendingInteractions }, deviceLink: { invoke } } });
    await expect(queryHostPendingPermissions('dev-1', 's1')).resolves.toEqual(expected);
    expect(invoke).toHaveBeenCalledWith('dev-1', 'maker:get-pending-interactions', ['s1', { includeAge: true }]);
    expect(getPendingInteractions).not.toHaveBeenCalled();
  });
});
