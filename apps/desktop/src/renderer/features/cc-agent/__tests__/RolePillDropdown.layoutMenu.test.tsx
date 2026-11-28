// @vitest-environment jsdom

import { Profiler } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';
import { __resetStickySessionOriginForTest } from '@/features/device-link/stickySessionOrigin';
import type { SessionStatusInfo } from '@/lib/makerChatStore';
import type { WorkerInfo } from '../hooks/useWorkers';
import { WorkerListToolbar } from '../RolePillDropdown';
import {
  addSessionAttention,
  clearSessionAttention,
  getSessionAttentionKinds,
} from '@/lib/sessionAttentionStore';
import {
  markWorkerAttention,
  __resetWorkerAttentionStoreForTest,
} from '../lib/workerAttentionStore';

const chat = vi.hoisted(() => ({
  statuses: new Map<string, SessionStatusInfo>(),
  listeners: new Set<() => void>(),
}));
vi.mock('@/lib/makerChatStore', () => ({
  makerChatStore: {
    getRunningSnapshot: () => chat.statuses,
    subscribeAll: (listener: () => void) => {
      chat.listeners.add(listener);
      return () => chat.listeners.delete(listener);
    },
  },
}));
function setPendingAsk(sessionId: string, pending: boolean) {
  chat.statuses = new Map(chat.statuses).set(sessionId, {
    isRunning: true,
    hasError: false,
    hasPendingAskUser: pending,
    hasPendingPermission: false,
    hasPendingPlanReview: false,
    hasPendingPluginSetup: false,
  });
  for (const listener of chat.listeners) listener();
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: { totalCount: number; activeCount: number }) =>
      key === 'orca.rolePill.workerCountSummary' && values
        ? `${values.totalCount} workers · ${values.activeCount} running`
        : key,
  }),
}));

vi.mock('@/hooks/useAppShortcut', () => ({
  useAppShortcutDisplay: () => '',
}));

vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: vi.fn(async () => false) }),
}));

// 与 RolePillDropdown.tsx 顶部的 hover 时序常量保持一致。
const HOVER_OPEN_DELAY_MS = 60;
const HOVER_CLOSE_DELAY_MS = 160;

function worker(overrides: Partial<WorkerInfo> = {}): WorkerInfo {
  return {
    workerId: 'worker-a',
    sessionId: 'session-a',
    role: 'developer',
    agent: 'codex',
    model: 'gpt-5.4',
    effort: null,
    label: null,
    status: 'idle',
    focused: true,
    idleSince: null,
    ...overrides,
  };
}

function renderToolbar(overrides: Partial<Parameters<typeof WorkerListToolbar>[0]> = {}) {
  const current = worker();
  return render(
    <WorkerListToolbar
      worker={current}
      workers={[current]}
      selectedWorkerId={current.workerId}
      activeWorkerCount={1}
      softLimit={5}
      hardLimit={8}
      onSwitchFocus={vi.fn()}
      onOpenCreate={vi.fn()}
      onOpenSettings={vi.fn()}
      onArchiveWorker={vi.fn()}
      {...overrides}
    />,
  );
}

function menuButton(): HTMLElement {
  return screen.getByRole('button', { name: 'orca.rolePill.layoutMenuLabel' });
}

// Tip 与 Radix Tooltip 都不产生 DOM 包装节点，⋮ 按钮的父元素即菜单 wrapper。
function wrapperOf(element: HTMLElement): HTMLElement {
  return element.parentElement as HTMLElement;
}

describe('WorkerLayoutMenu hover interaction', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it.each(['tabs', 'dropdown'])(
    '%s 标题只数 running，但创建上限仍计入空闲、完成和出错 Worker',
    (layout) => {
      localStorage.setItem('orca-worker-list-layout-v1', layout);
      const workers = (['running', 'running', 'idle', 'done', 'error'] as const).map(
        (status, index) =>
          worker({
            workerId: `worker-${index}`,
            sessionId: `session-${index}`,
            status,
            focused: index === 0,
          }),
      );
      const onOpenCreate = vi.fn();
      const onOpenSettings = vi.fn();
      renderToolbar({
        worker: workers[0],
        workers,
        selectedWorkerId: workers[0].workerId,
        activeWorkerCount: 5,
        softLimit: 3,
        hardLimit: 5,
        onOpenCreate,
        onOpenSettings,
      });
      fireEvent.click(screen.getByRole('button', { name: 'orca.rolePill.settingsCollaboration' }));
      expect(onOpenSettings).toHaveBeenCalledOnce();
      expect(onOpenCreate).not.toHaveBeenCalled();
      fireEvent.click(
        layout !== 'dropdown' ? menuButton() : screen.getByRole('button', { name: /^developer/ }),
      );
      expect(screen.getByText('5 workers · 2 running')).toBeTruthy();
    },
  );

  it('hover 后经打开延迟临时展开菜单', () => {
    renderToolbar();
    const wrapper = wrapperOf(menuButton());
    fireEvent.mouseEnter(wrapper);
    act(() => {
      vi.advanceTimersByTime(HOVER_OPEN_DELAY_MS);
    });
    expect(screen.getByText('orca.rolePill.workersHeader')).toBeTruthy();
  });

  it('鼠标移出后经关闭延迟收起临时展开的菜单', () => {
    renderToolbar();
    const wrapper = wrapperOf(menuButton());
    fireEvent.mouseEnter(wrapper);
    act(() => {
      vi.advanceTimersByTime(HOVER_OPEN_DELAY_MS);
    });
    fireEvent.mouseLeave(wrapper);
    act(() => {
      vi.advanceTimersByTime(HOVER_CLOSE_DELAY_MS);
    });
    expect(screen.queryByText('orca.rolePill.workersHeader')).toBeNull();
  });

  it('点击固定菜单，鼠标移出后保持打开', () => {
    renderToolbar();
    const wrapper = wrapperOf(menuButton());
    fireEvent.click(menuButton());
    fireEvent.mouseLeave(wrapper);
    act(() => {
      vi.advanceTimersByTime(HOVER_CLOSE_DELAY_MS);
    });
    expect(screen.getByText('orca.rolePill.workersHeader')).toBeTruthy();
  });

  it('再次点击取消固定并关闭菜单', () => {
    renderToolbar();
    fireEvent.click(menuButton());
    expect(screen.getByText('orca.rolePill.workersHeader')).toBeTruthy();
    fireEvent.click(menuButton());
    expect(screen.queryByText('orca.rolePill.workersHeader')).toBeNull();
  });

  it('hover 临时展开后点击可固定，移出不再关闭', () => {
    renderToolbar();
    const wrapper = wrapperOf(menuButton());
    fireEvent.mouseEnter(wrapper);
    act(() => {
      vi.advanceTimersByTime(HOVER_OPEN_DELAY_MS);
    });
    fireEvent.click(menuButton());
    fireEvent.mouseLeave(wrapper);
    act(() => {
      vi.advanceTimersByTime(HOVER_CLOSE_DELAY_MS * 2);
    });
    expect(screen.getByText('orca.rolePill.workersHeader')).toBeTruthy();
  });

  it('点击外部区域关闭菜单', () => {
    renderToolbar();
    fireEvent.click(menuButton());
    expect(screen.getByText('orca.rolePill.workersHeader')).toBeTruthy();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByText('orca.rolePill.workersHeader')).toBeNull();
  });

  it('按 Escape 关闭菜单', () => {
    renderToolbar();
    fireEvent.click(menuButton());
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByText('orca.rolePill.workersHeader')).toBeNull();
  });

  it('选择布局选项后关闭菜单', () => {
    renderToolbar();
    fireEvent.click(menuButton());
    fireEvent.click(screen.getByRole('button', { name: 'orca.rolePill.layoutDropdown' }));
    expect(screen.queryByText('orca.rolePill.workersHeader')).toBeNull();
  });
});

// 多行布局：用户要求全部 Worker 换行可见，按「有问题/等回答 > 进行中 > 停止中」、同层最后触发
// 越晚越前排序，状态变化后立即重排。走真实布局菜单与提醒 store，不直接调排序 helper。
describe('Worker list multi-row layout', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    cleanup();
    for (const id of getSessionAttentionKinds().keys())
      clearSessionAttention(id, { intent: 'explicit' });
    __resetWorkerAttentionStoreForTest();
  });

  const rowsOrder = () =>
    Array.from(
      screen.getByTestId('worker-rows-list').querySelectorAll<HTMLElement>('[data-worker-id]'),
    ).map((element) => element.dataset.workerId);

  it('切到多行后全部 Worker 换行可见、选择被记住，并能切回平铺与下拉', () => {
    const workers = Array.from({ length: 6 }, (_, index) =>
      worker({ workerId: `w${index}`, sessionId: `s${index}`, focused: index === 0 }),
    );
    renderToolbar({ worker: workers[0], workers, selectedWorkerId: 'w0' });
    expect(screen.getByTestId('worker-tabs-scroller')).toBeTruthy();

    fireEvent.click(menuButton());
    fireEvent.click(screen.getByRole('button', { name: 'orca.rolePill.layoutRows' }));
    expect(rowsOrder()).toHaveLength(6);
    expect(screen.queryByTestId('worker-tabs-scroller')).toBeNull();
    expect(screen.queryByRole('button', { name: 'orca.rolePill.scrollWorkersRight' })).toBeNull();
    expect(localStorage.getItem('orca-worker-list-layout-v1')).toBe('rows');
    // 多行保留菜单名单，编辑入口与平铺相同。
    fireEvent.click(menuButton());
    expect(screen.getByText('orca.rolePill.workersHeader')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'orca.rolePill.layoutDropdown' }));
    expect(screen.queryByTestId('worker-rows-list')).toBeNull();
    expect(screen.getByRole('button', { name: /^developer/ })).toBeTruthy();
    fireEvent.click(menuButton());
    fireEvent.click(screen.getByRole('button', { name: 'orca.rolePill.layoutTabs' }));
    expect(screen.getByTestId('worker-tabs-scroller')).toBeTruthy();
    expect(localStorage.getItem('orca-worker-list-layout-v1')).toBe('tabs');
  });

  // #13566: unit, real toolbar; completion/focus cannot reorder dispatch ties.
  it('keeps B before A after both finish, stable ties and focus switches', () => {
    localStorage.setItem('orca-worker-list-layout-v1', 'rows');
    const workers = ['A', 'B', 'C'].map((id, index) => worker({
      workerId: id, sessionId: `s-${id}`, focused: false, status: 'done',
      lastTriggeredAt: index === 0 ? 1000 : 2000,
    }));
    markWorkerAttention('A');
    const view = renderToolbar({ workers, worker: workers[0], selectedWorkerId: 'A' });
    expect(rowsOrder()).toEqual(['B', 'C', 'A']);
    view.rerender(<WorkerListToolbar
      workers={workers} worker={workers[1]} selectedWorkerId="B"
      activeWorkerCount={3} softLimit={5} hardLimit={8}
      onSwitchFocus={vi.fn()} onOpenCreate={vi.fn()}
      onArchiveWorker={vi.fn()}
    />);
    expect(rowsOrder()).toEqual(['B', 'C', 'A']);
  });

  it('按 有问题/等回答 > 进行中 > 停止中 排序，同层最后触发越晚越前，状态变化即时重排', () => {
    localStorage.setItem('orca-worker-list-layout-v1', 'rows');
    const make = (id: string, status: WorkerInfo['status'], lastTriggeredAt: number) =>
      worker({ workerId: id, sessionId: `s-${id}`, status, lastTriggeredAt, focused: false });
    const workers = [
      make('idle-old', 'idle', 500),
      make('run-old', 'running', 100),
      make('run-new', 'running', 300),
      make('done-new', 'done', 900),
      make('waiting', 'idle', 50),
      make('failed', 'idle', 10),
    ];
    addSessionAttention('s-waiting', 'awaiting');
    addSessionAttention('s-failed', 'error');
    const props = { worker: workers[0], selectedWorkerId: null };
    const view = renderToolbar({ ...props, workers });
    expect(rowsOrder()).toEqual(['waiting', 'failed', 'run-new', 'run-old', 'done-new', 'idle-old']);

    // 停止中的 Worker 被重新触发 → 进入「进行中」且最近触发，排到该层最前。
    const retriggered = workers.map((item) =>
      item.workerId === 'idle-old' ? { ...item, status: 'running' as const, lastTriggeredAt: 1000 } : item,
    );
    view.rerender(
      <WorkerListToolbar
        {...props}
        workers={retriggered}
        activeWorkerCount={6}
        softLimit={5}
        hardLimit={8}
        onSwitchFocus={vi.fn()}
        onOpenCreate={vi.fn()}
        onArchiveWorker={vi.fn()}
      />,
    );
    expect(rowsOrder()).toEqual(['waiting', 'failed', 'idle-old', 'run-new', 'run-old', 'done-new']);

    // 用户回答后提醒消失 → 回到停止中，按触发时间排在该层末尾。
    act(() => clearSessionAttention('s-waiting', { intent: 'explicit' }));
    expect(rowsOrder()).toEqual(['failed', 'idle-old', 'run-new', 'run-old', 'done-new', 'waiting']);
  });
});

// 使用真实提醒 store 驱动四个展示入口；防止只修 helper 却漏接其中一份列表。
describe('Worker list task attention', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    cleanup();
    for (const id of getSessionAttentionKinds().keys())
      clearSessionAttention(id, { intent: 'explicit' });
    __resetWorkerAttentionStoreForTest();
    chat.statuses = new Map();
    remoteProjectsStore.__resetPinnedOriginsForTest();
    __resetStickySessionOriginForTest();
  });

  it.each(['tabs', 'dropdown', 'rows'] as const)(
    '%s：本机 Worker 关闭任务错误后，运行态仍 error 也清除列表错误并恢复蓝/绿点',
    (layout) => {
      localStorage.setItem('orca-worker-list-layout-v1', layout);
      const current = worker();
      const hidden = worker({
        workerId: 'worker-b',
        sessionId: 'session-b',
        role: 'reviewer',
        focused: false,
        status: 'error',
      });
      addSessionAttention(hidden.sessionId, 'error');
      const view = renderToolbar({ worker: current, workers: [current, hidden] });
      const openList = () =>
        fireEvent.click(
          layout !== 'dropdown' ? menuButton() : screen.getByRole('button', { name: /^developer/ }),
        );

      // 未展开时：平铺 tab 或折叠入口都必须能看出隐藏 Worker 出错。
      expect(screen.getByLabelText('orca.rolePill.errorBadgeAria')).toBeTruthy();
      openList();
      const row = screen.getAllByRole('button', { name: /reviewer.*gpt-5.4/ })[0];
      expect(row.className).toContain('border-[var(--error-fg)]');
      expect(
        within(row.parentElement!).getByLabelText('orca.rolePill.errorBadgeAria'),
      ).toBeTruthy();

      act(() => {
        clearSessionAttention(hidden.sessionId, { intent: 'explicit' });
        addSessionAttention(hidden.sessionId, 'awaiting');
        markWorkerAttention(hidden.workerId);
      });
      expect(screen.queryByLabelText('orca.rolePill.errorBadgeAria')).toBeNull();
      expect(within(row).getByLabelText('orca.rolePill.awaitingBadgeAria')).toBeTruthy();
      expect(screen.queryByLabelText('orca.rolePill.unread')).toBeNull();
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(screen.getByLabelText('orca.rolePill.awaitingBadgeAria')).toBeTruthy();

      // 当前 Worker 等确认仍显示；错误优先于当前/隐藏 Worker 的蓝点。
      act(() => addSessionAttention(current.sessionId, 'awaiting'));
      expect(screen.getAllByLabelText('orca.rolePill.awaitingBadgeAria').length).toBe(
        layout !== 'dropdown' ? 2 : 1,
      );
      act(() => addSessionAttention(current.sessionId, 'error'));
      expect(screen.getByRole('button', { name: /^developer/ }).className).toContain(
        'border-[var(--error-',
      );
      if (layout === 'dropdown')
        expect(screen.queryByLabelText('orca.rolePill.awaitingBadgeAria')).toBeNull();
      act(() => {
        clearSessionAttention(current.sessionId, { intent: 'explicit' });
        clearSessionAttention(hidden.sessionId, { intent: 'explicit' });
      });
      expect(screen.queryByLabelText('orca.rolePill.errorBadgeAria')).toBeNull();
      expect(screen.queryByLabelText('orca.rolePill.awaitingBadgeAria')).toBeNull();
      openList();
      expect(screen.getAllByLabelText('orca.rolePill.unread').length).toBeGreaterThan(0);
      // 选中完成 Worker 后绿点隐藏，原来的「完成未读」语义不变。
      view.rerender(
        <WorkerListToolbar
          worker={hidden}
          workers={[
            { ...current, focused: false },
            { ...hidden, focused: true },
          ]}
          selectedWorkerId={hidden.workerId}
          activeWorkerCount={1}
          softLimit={5}
          hardLimit={8}
          onSwitchFocus={vi.fn()}
          onOpenCreate={vi.fn()}
          onOpenSettings={vi.fn()}
          onArchiveWorker={vi.fn()}
        />,
      );
      expect(screen.queryByLabelText('orca.rolePill.unread')).toBeNull();
    },
  );

  it.each(['execution-device', 'remote-worker', 'remote-lead'] as const)('%s 不读本机同 id 的任务提醒，仍保留运行态 error；错误压过完成未读', (location) => {
    const remote = worker({
      executionDevice: location === 'execution-device' ? {
        deviceId: 'other-device',
        remoteSessionId: 'remote-session',
        deviceName: 'Other Mac',
        reachable: true,
        workingDir: null,
      } : undefined,
    });
    const leadSessionId = 'remote-lead';
    if (location !== 'execution-device') {
      remoteProjectsStore.pinSessionOrigin('other-device', location === 'remote-lead' ? leadSessionId : remote.sessionId);
    }
    addSessionAttention(remote.sessionId, 'error');
    const view = renderToolbar({ worker: remote, workers: [remote], leadSessionId });
    expect(screen.queryByLabelText('orca.rolePill.errorBadgeAria')).toBeNull();
    act(() => addSessionAttention(remote.sessionId, 'awaiting'));
    expect(screen.queryByLabelText('orca.rolePill.awaitingBadgeAria')).toBeNull();
    view.unmount();
    markWorkerAttention(remote.workerId);
    renderToolbar({
      leadSessionId,
      worker: remote,
      workers: [{ ...remote, focused: false, status: 'error' }],
      selectedWorkerId: null,
      clearAttentionWhenVisible: false,
    });
    expect(screen.getByLabelText('orca.rolePill.errorBadgeAria')).toBeTruthy();
    expect(screen.queryByLabelText('orca.rolePill.unread')).toBeNull();
  });

  it.each(['tabs', 'dropdown', 'rows'] as const)(
    '%s：切回后任务 awaiting 已清，未处理确认仍亮，处理后消失',
    (layout) => {
      localStorage.setItem('orca-worker-list-layout-v1', layout);
      const current = worker();
      renderToolbar();
      act(() => {
        setPendingAsk(current.sessionId, true);
        addSessionAttention(current.sessionId, 'awaiting');
      });
      act(() => clearSessionAttention(current.sessionId));
      expect(getSessionAttentionKinds().has(current.sessionId)).toBe(false);
      expect(screen.getByLabelText('orca.rolePill.awaitingBadgeAria')).toBeTruthy();
      fireEvent.click(
        layout !== 'dropdown' ? menuButton() : screen.getByRole('button', { name: /developer/ }),
      );
      expect(screen.getAllByLabelText('orca.rolePill.awaitingBadgeAria').length).toBe(2);
      act(() => setPendingAsk(current.sessionId, false));
      expect(screen.queryByLabelText('orca.rolePill.awaitingBadgeAria')).toBeNull();
    },
  );

  // #13566: unit, real toolbar; rows previously hid the only edit entry.
  it('keeps every Worker editable from the multi-row menu', () => {
    localStorage.setItem('orca-worker-list-layout-v1', 'rows');
    const onEditWorker = vi.fn();
    renderToolbar({ onEditWorker });
    fireEvent.click(menuButton());
    fireEvent.click(screen.getByRole('button', { name: 'orca.rolePill.editWorkerAria' }));
    expect(onEditWorker).toHaveBeenCalledWith('worker-a');
    expect(screen.queryByText('orca.rolePill.workersHeader')).toBeNull();
    expect(screen.getByTestId('worker-rows-list')).toBeTruthy();
  });

  it('其他任务的提醒变化不重新渲染 Worker 列表', () => {
    const onRender = vi.fn();
    const current = worker();
    render(
      <Profiler id="workers" onRender={onRender}>
        <WorkerListToolbar
          worker={current}
          workers={[current]}
          selectedWorkerId={current.workerId}
          activeWorkerCount={1}
          softLimit={5}
          hardLimit={8}
          onSwitchFocus={vi.fn()}
          onOpenCreate={vi.fn()}
          onOpenSettings={vi.fn()}
          onArchiveWorker={vi.fn()}
        />
      </Profiler>,
    );
    onRender.mockClear();
    act(() => addSessionAttention('unrelated-session', 'error'));
    expect(onRender).not.toHaveBeenCalled();
    act(() => {
      setPendingAsk('unrelated-session', true);
      for (let i = 0; i < 100; i++) setPendingAsk(current.sessionId, false);
    });
    expect(onRender).not.toHaveBeenCalled();
    act(() => addSessionAttention(current.sessionId, 'awaiting'));
    expect(onRender).toHaveBeenCalled();
    expect(screen.getByLabelText('orca.rolePill.awaitingBadgeAria')).toBeTruthy();
  });
});
