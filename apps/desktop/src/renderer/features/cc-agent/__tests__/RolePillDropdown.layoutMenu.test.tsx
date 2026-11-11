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
        layout === 'tabs' ? menuButton() : screen.getByRole('button', { name: /^developer/ }),
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

  it.each(['tabs', 'dropdown'] as const)(
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
          layout === 'tabs' ? menuButton() : screen.getByRole('button', { name: /^developer/ }),
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
        layout === 'tabs' ? 2 : 1,
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

  it.each(['tabs', 'dropdown'] as const)(
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
        layout === 'tabs' ? menuButton() : screen.getByRole('button', { name: /developer/ }),
      );
      expect(screen.getAllByLabelText('orca.rolePill.awaitingBadgeAria').length).toBe(2);
      act(() => setPendingAsk(current.sessionId, false));
      expect(screen.queryByLabelText('orca.rolePill.awaitingBadgeAria')).toBeNull();
    },
  );

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
