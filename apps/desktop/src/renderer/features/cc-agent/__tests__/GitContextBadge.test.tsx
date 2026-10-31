// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Tooltip } from '@/components/ui/tooltip';
import type { PrStatusResult, SessionPrRef, SessionPrRefAction } from '@cindy/maker-shared';
import { sharedTaskHostPeer } from '@cindy/device-link';
import type { Session } from '@/lib/ccAgent.types';
import type { SessionGitContext } from '@/hooks/useSessionGitContext';

const { gitContextMock } = vi.hoisted(() => ({
  gitContextMock: vi.fn<() => SessionGitContext>(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key} ${JSON.stringify(params)}` : key,
  }),
}));
vi.mock('@/hooks/useSessionGitContext', () => ({
  useSessionGitContext: gitContextMock,
}));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ dataOwnerId: 'test' }) }));

import { GitContextBadge } from '../GitContextBadge';
import { SessionPrManager } from '../SessionPrManager';

const managerMocks = vi.hoisted(() => ({
  invalidate: vi.fn(),
  sortables: [] as { element: HTMLElement; options: Record<string, unknown> }[],
}));
vi.mock('@/contexts/PrRefsContext', () => ({
  usePrActions: () => ({ invalidateRemotePrRefs: managerMocks.invalidate }),
}));
vi.mock('sortablejs', () => ({
  default: {
    create: (element: HTMLElement, options: Record<string, unknown>) => {
      managerMocks.sortables.push({ element, options });
      return {
        option: (key: string, value: unknown) => {
          options[key] = value;
        },
        destroy: () => {},
      };
    },
  },
}));

const dialogueSession = {
  id: 'session-1',
  workspaceKind: 'dialogue',
  workingDir: '/Users/me/Cindy/dialogues/abc',
  remoteHostId: null,
} as Session;

afterEach(() => {
  cleanup();
  gitContextMock.mockReset();
  vi.useRealTimers();
});

describe('GitContextBadge', () => {
  it('对话目录不是 git 仓库时,仍显示消息里的 PR 徽标', () => {
    gitContextMock.mockReturnValue({
      head: null,
      branchSource: null,
      prRefs: [
        {
          id: 'ref-1',
          sessionId: 'session-1',
          owner: 'octo',
          repo: 'repo',
          prNumber: 7,
          url: 'https://github.com/octo/repo/pull/7',
          firstSeenAt: 1,
          lastSeenAt: 2,
        },
      ],
      prStatuses: new Map(),
    });

    render(
      <Tooltip.Provider>
        <GitContextBadge session={dialogueSession} />
      </Tooltip.Provider>,
    );

    expect(screen.getByRole('button', { name: /pr.openAria/ }).textContent).toContain('#7');
    expect(screen.queryByLabelText(/ccAgent\.gitContext\.branchAria/)).toBeNull();
  });

  it('没有自动关联时仍能从管理入口手动添加 PR', () => {
    gitContextMock.mockReturnValue({
      head: null,
      branchSource: null,
      prRefs: [],
      prStatuses: new Map(),
    });

    render(
      <Tooltip.Provider>
        <GitContextBadge session={dialogueSession} />
      </Tooltip.Provider>,
    );

    expect(screen.getByRole('button', { name: /manage.title/ })).toBeTruthy();
  });

  // Unit regression: the shared-task host intentionally rejects management
  // reads. Keep PR viewing available without offering this unusable entry;
  // previous remote coverage only exercised same-account device IDs.
  it('共享访客不显示管理入口，同账号远程仍可管理且两者保留PR查看', () => {
    const { context, rerender } = renderHeader();
    for (const deviceLinkDeviceId of [
      sharedTaskHostPeer('shared-task', 'host-device'),
      'host-device',
    ]) {
      gitContextMock.mockReturnValue(context);
      rerender(
        <Tooltip.Provider>
          <GitContextBadge session={{ ...dialogueSession, deviceLinkDeviceId }} />
        </Tooltip.Provider>,
      );
      expect(Boolean(screen.queryByRole('button', { name: /manage.title/ }))).toBe(
        deviceLinkDeviceId === 'host-device',
      );
      expect(screen.getAllByRole('button', { name: /pr.openAria/ })).toHaveLength(2);
    }
  });

  // Unit: one PR is now one navigation button. Previous tests pinned a popover
  // on click, which is no longer a supported behavior. Minimum timing inputs:
  // first hover 299/300ms, an already-open sibling, leaving and re-entering.
  // Production header and fake timers verify focus, navigation and visible data.
  function renderHeader(unresolvedCount = 2) {
    vi.useFakeTimers();
    const openExternal = vi.fn();
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        openExternal,
        gitContext: { githubSetupStatus: vi.fn().mockResolvedValue({ phase: 'idle' }) },
      },
    });
    const refs = [7, 8].map((prNumber) => ({
      id: `ref-${prNumber}`,
      sessionId: dialogueSession.id,
      owner: 'octo',
      repo: 'repo',
      prNumber,
      url: `https://github.com/octo/repo/pull/${prNumber}`,
      firstSeenAt: 1,
      lastSeenAt: 2,
    }));
    const context: SessionGitContext = {
      head: null,
      branchSource: null,
      prRefs: refs,
      prStatuses: new Map(
        refs.map((ref) => [
          `octo/repo#${ref.prNumber}`,
          {
            ...ref,
            ok: true as const,
            status: 'open' as const,
            title: ref.prNumber === 7 ? 'A real PR title' : '',
            htmlUrl: ref.url,
            branch: 'fix',
            unresolvedCount,
            checks: { total: 7, failed: 2, passed: 4, pending: 1, skipped: 0 },
          },
        ]),
      ),
    };
    gitContextMock.mockReturnValue(context);
    const view = render(
      <Tooltip.Provider>
        <input aria-label="composer" />
        <GitContextBadge session={dialogueSession} />
      </Tooltip.Provider>,
    );
    const triggers = screen.getAllByRole('button', { name: /pr.openAria/ });
    const composer = screen.getByRole('textbox');
    composer.focus();
    return { ...view, triggers, composer, openExternal, context };
  }
  function pointer(element: Element, type: 'over' | 'out' | 'down', pointerType = 'mouse') {
    fireEvent(
      element,
      Object.assign(new MouseEvent(`pointer${type}`, { bubbles: true }), { pointerType }),
    );
  }
  function advance(ms: number) {
    act(() => vi.advanceTimersByTime(ms));
  }

  it('首次hover延迟打开，不抢焦点；跨间隙重入取消关闭，离开300ms关闭', () => {
    const {
      triggers: [trigger],
      composer,
    } = renderHeader();
    pointer(trigger, 'over');
    advance(299);
    expect(screen.queryByRole('dialog')).toBeNull();
    advance(1);
    const panel = screen.getByRole('dialog');
    expect(document.activeElement).toBe(composer);
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(screen.getByRole('link').textContent).toContain('octo/repo #7');
    pointer(trigger, 'out');
    advance(299);
    pointer(panel, 'over');
    advance(300);
    expect(screen.getByRole('dialog')).toBe(panel);
    pointer(panel, 'out');
    advance(299);
    expect(screen.getByRole('dialog')).toBe(panel);
    advance(1);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(composer);
    pointer(trigger, 'over');
    advance(100);
    pointer(trigger, 'out');
    advance(500);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('已有面板时相邻PR立即切换，Escape关闭；任务切换清理计时器', () => {
    const {
      triggers: [a, b],
      rerender,
    } = renderHeader();
    pointer(a, 'over');
    advance(300);
    pointer(a, 'out');
    pointer(b, 'over');
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.getByRole('link').textContent).toBe(
      'octo/repo #8 · ccAgent.gitContext.pr.status.open',
    );
    fireEvent.keyDown(b, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    pointer(b, 'out');
    pointer(a, 'over');
    rerender(
      <Tooltip.Provider>
        <GitContextBadge session={{ ...dialogueSession, id: 'other' }} />
      </Tooltip.Provider>,
    );
    advance(500);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('评论和检查区域都直接打开PR，点击收起并抑制原位重弹，标题仍可打开链接', () => {
    const {
      triggers: [trigger],
      openExternal,
    } = renderHeader();
    pointer(trigger, 'over');
    advance(300);
    fireEvent.click(screen.getByRole('link'));
    expect(openExternal).toHaveBeenLastCalledWith('https://github.com/octo/repo/pull/7');
    for (const icon of ['message-square', 'circle-x']) {
      fireEvent.click(trigger.querySelector(`.lucide-${icon}`)!);
      expect(openExternal).toHaveBeenLastCalledWith('https://github.com/octo/repo/pull/7');
      expect(screen.queryByRole('dialog')).toBeNull();
      pointer(trigger, 'over');
      advance(500);
      expect(screen.queryByRole('dialog')).toBeNull();
      pointer(trigger, 'out');
      pointer(trigger, 'over');
      advance(300);
      expect(screen.getByRole('dialog')).toBeTruthy();
    }
  });

  it('focus-visible显示只读面板且失焦/Escape关闭，鼠标及触屏焦点不打开', () => {
    const {
      triggers: [trigger],
    } = renderHeader();
    const matches = vi
      .spyOn(trigger, 'matches')
      .mockImplementation((selector) => selector === ':focus-visible');
    fireEvent.focus(trigger);
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.keyDown(trigger, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.blur(trigger);
    fireEvent.focus(trigger);
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.blur(trigger);
    expect(screen.queryByRole('dialog')).toBeNull();
    pointer(trigger, 'down');
    fireEvent.focus(trigger);
    advance(500);
    expect(screen.queryByRole('dialog')).toBeNull();
    matches.mockRestore();
  });

  it('触屏和笔只点击跳转，不打开悬停面板', () => {
    const {
      triggers: [trigger],
      openExternal,
    } = renderHeader();
    for (const type of ['touch', 'pen']) {
      pointer(trigger, 'over', type);
      pointer(trigger, 'down', type);
      fireEvent.focus(trigger);
      advance(500);
      expect(screen.queryByRole('dialog')).toBeNull();
      fireEvent.click(trigger);
      expect(openExternal).toHaveBeenLastCalledWith('https://github.com/octo/repo/pull/7');
      fireEvent.blur(trigger);
      pointer(trigger, 'out', type);
    }
  });

  // Unit regression: no result is not a failed request. The same open panel
  // must distinguish an absent cache entry from a subsequent fetch-failed result;
  // prior coverage only checked missing counts and setup guidance.
  it('尚无状态显示中性提示，真正获取失败仍显示失败提示', () => {
    const { context, rerender } = renderHeader();
    const header = (
      <Tooltip.Provider>
        <GitContextBadge session={dialogueSession} />
      </Tooltip.Provider>
    );
    gitContextMock.mockReturnValue({ ...context, prStatuses: new Map() });
    rerender(header);
    pointer(screen.getAllByRole('button', { name: /pr.openAria/ })[0], 'over');
    advance(300);
    expect(screen.getByText('ccAgent.gitContext.pr.statusNotFetched')).toBeTruthy();
    expect(screen.queryByText('ccAgent.gitContext.pr.statusUnknown')).toBeNull();
    gitContextMock.mockReturnValue({
      ...context,
      prStatuses: new Map([
        [
          'octo/repo#7',
          {
            ok: false,
            owner: 'octo',
            repo: 'repo',
            prNumber: 7,
            reason: 'fetch-failed',
          },
        ],
      ]),
    });
    rerender(
      <Tooltip.Provider>
        <GitContextBadge session={dialogueSession} />
      </Tooltip.Provider>,
    );
    expect(screen.getByText('ccAgent.gitContext.pr.statusUnknown')).toBeTruthy();
    expect(screen.queryByText('ccAgent.gitContext.pr.statusNotFetched')).toBeNull();
  });

  it.each(['gh-missing', 'gh-not-logged-in'] as const)(
    '面板保留仓库、状态和安装登录提示：%s',
    async (reason) => {
      const { context, rerender } = renderHeader();
      gitContextMock.mockReturnValue({
        ...context,
        prStatuses: new Map([
          ['octo/repo#7', { ok: false, owner: 'octo', repo: 'repo', prNumber: 7, reason }],
        ]),
      });
      rerender(
        <Tooltip.Provider>
          <GitContextBadge session={dialogueSession} />
        </Tooltip.Provider>,
      );
      const trigger = screen.getByRole('button', {
        name: reason === 'gh-missing' ? /guidance.install.aria/ : /guidance.login.aria/,
      });
      pointer(trigger, 'over');
      advance(300);
      expect(screen.getByRole('link').textContent).toContain('octo/repo #7');
      expect(
        screen.getByText(
          reason === 'gh-missing'
            ? 'ccAgent.gitContext.pr.ghMissing'
            : 'ccAgent.gitContext.pr.ghNotLoggedIn',
        ),
      ).toBeTruthy();
      // Unavailable data is hidden; the remaining action must still open real setup UI.
      expect(screen.queryByText('ccAgent.gitContext.pr.unresolvedLabel')).toBeNull();
      expect(screen.queryByText('ccAgent.gitContext.pr.checks')).toBeNull();
      await act(async () => {
        fireEvent.click(
          screen.getByRole('button', {
            name: reason === 'gh-missing' ? /guidance.install.hint/ : /guidance.login.hint/,
          }),
        );
      });
      expect(screen.getByRole('dialog').textContent).toContain(
        reason === 'gh-missing' ? 'setup.stages.install' : 'setup.stages.login',
      );
    },
  );

  // Unit regression: show only actionable review counts. Prior coverage hid
  // unavailable counts but left zero visible; 100 -> 0 also checks the restored
  // header cap while the panel and accessible label retain the exact count.
  it('评论仅在大于零时显示，零评论且检查不可用时只保留面板头部', () => {
    const { context, rerender, triggers } = renderHeader(100);
    expect(triggers[0].querySelector('[aria-label*="pr.unresolved"]')?.textContent).toBe('99+');
    expect(
      triggers[0].querySelector('[aria-label*="pr.unresolved"]')?.getAttribute('aria-label'),
    ).toBe('ccAgent.gitContext.pr.unresolved {"count":100}');
    pointer(triggers[0], 'over');
    advance(300);
    expect(
      screen.getByText('ccAgent.gitContext.pr.unresolvedLabel').nextElementSibling?.textContent,
    ).toBe('100');

    const status = context.prStatuses.get('octo/repo#7')!;
    for (const checks of [status.ok ? status.checks : null, null]) {
      gitContextMock.mockReturnValue({
        ...context,
        prStatuses: new Map([['octo/repo#7', { ...status, unresolvedCount: 0, checks }]]),
      });
      rerender(
        <Tooltip.Provider>
          <input aria-label="composer" />
          <GitContextBadge session={dialogueSession} />
        </Tooltip.Provider>,
      );
      expect(screen.queryByText('ccAgent.gitContext.pr.unresolvedLabel')).toBeNull();
      if (checks !== null) {
        expect(screen.getByText('ccAgent.gitContext.pr.checks')).toBeTruthy();
      } else {
        // No empty section or separator remains after the header link.
        expect(Array.from(screen.getByRole('dialog').children)).toEqual([screen.getByRole('link')]);
      }
    }
  });

  // #7924: passing + skipped is a successful aggregate; keep both panel categories.
  it.each([
    [{ total: 25, passed: 23, skipped: 2, failed: 0, pending: 0 }, 'check'],
    [{ total: 2, passed: 0, skipped: 2, failed: 0, pending: 0 }, 'check'],
    [{ total: 0, passed: 0, skipped: 0, failed: 0, pending: 0 }, 'circle-minus'],
    [null, 'circle-help'],
  ] as const)('检查汇总保留成功、无检查和未知区别：%j', (checks, icon) => {
    const { context, rerender } = renderHeader();
    const status = context.prStatuses.get('octo/repo#7')!;
    gitContextMock.mockReturnValue({
      ...context,
      prStatuses: new Map([['octo/repo#7', { ...status, checks }]]),
    });
    rerender(
      <Tooltip.Provider>
        <GitContextBadge session={dialogueSession} />
      </Tooltip.Provider>,
    );
    const trigger = screen.getAllByRole('button', { name: /pr.openAria/ })[0];
    expect(trigger.querySelector(`.lucide-${icon}`)).toBeTruthy();
    expect(trigger.querySelector(`.lucide-${icon}`)?.parentElement?.textContent).toBe('');
    pointer(trigger, 'over');
    advance(300);
    // Panel polish: zero categories must disappear, without hiding a confirmed
    // zero total or collapsing skipped/neutral into passed. Unknown rows are absent.
    expect(Boolean(screen.queryByText('ccAgent.gitContext.pr.checks'))).toBe(checks !== null);
    for (const [label, count] of [
      ['failed', checks?.failed ?? 0],
      ['pending', checks?.pending ?? 0],
      ['passed', checks?.passed ?? 0],
      ['skippedLabel', checks?.skipped ?? 0],
    ] as const) {
      const category = screen.queryByText(`ccAgent.gitContext.pr.${label}`);
      if (count > 0) expect(category?.previousElementSibling?.textContent).toBe(String(count));
      else expect(category).toBeNull();
    }
  });
});

// Unit: the management entry must query beyond the header's three PRs and
// preserve keyboard navigation through a persisted reorder. Existing header
// tests never opened management. Four active rows + one removed is minimal.
describe('SessionPrManager', () => {
  function fixture(deviceId?: string, activeCount = 4, readOnly = false) {
    managerMocks.sortables.length = 0;
    managerMocks.invalidate.mockClear();
    let refs: SessionPrRef[] = Array.from({ length: activeCount + 1 }, (_, index) => index + 1).map(
      (prNumber) => ({
        id: `manager-${prNumber}`,
        sessionId: dialogueSession.id,
        owner: 'octo',
        repo: 'repo',
        prNumber,
        url: `https://github.com/octo/repo/pull/${prNumber}`,
        firstSeenAt: 1,
        lastSeenAt: 1,
        pinned: prNumber === 1,
        removedAt: prNumber === activeCount + 1 ? 1 : null,
      }),
    );
    const statusFor = (prNumber: number): PrStatusResult =>
      prNumber === 3
        ? { ok: false, owner: 'octo', repo: 'repo', prNumber, reason: 'fetch-failed' }
        : {
            ok: true,
            owner: 'octo',
            repo: 'repo',
            prNumber,
            status: 'open',
            title: `Title ${prNumber}`,
            htmlUrl: `https://github.com/octo/repo/pull/${prNumber}`,
            branch: 'main',
            unresolvedCount: 0,
          };
    const statuses = vi.fn(async (queries: { prNumber: number }[]) =>
      queries.map((q) => statusFor(q.prNumber)),
    );
    const manage = vi.fn(async (action: SessionPrRefAction | { action: 'list' }) => {
      if (action.action === 'reorder') {
        const group = action.ids.map((id) => refs.find((row) => row.id === id)!);
        refs = [...refs.filter((row) => !action.ids.includes(row.id)), ...group];
        refs.sort((a, b) => Number(b.pinned) - Number(a.pinned));
      }
      if (action.action === 'restore')
        refs = refs.map((row) => (row.id === action.id ? { ...row, removedAt: null } : row));
      return refs;
    });
    const invoke = vi.fn(async (_device: string, channel: string, args: unknown[]) => {
      if (channel === 'git-context:pr-status')
        return statuses((args[0] as { queries: { prNumber: number }[] }).queries);
      return manage(args[0] as SessionPrRefAction);
    });
    const openExternal = vi.fn();
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        openExternal,
        gitContext: { managePrRefs: manage, getPrStatuses: statuses },
        deviceLink: { invoke },
      },
    });
    const session = { ...dialogueSession, deviceLinkDeviceId: deviceId };
    if (readOnly)
      gitContextMock.mockReturnValue({
        head: null,
        branchSource: null,
        prRefs: refs.filter((row) => row.removedAt == null),
        prStatuses: new Map(),
      });
    const view = render(
      <Tooltip.Provider>
        {readOnly ? (
          <GitContextBadge session={{ ...session, source: 'review' }} />
        ) : (
          <SessionPrManager session={session} />
        )}
      </Tooltip.Provider>,
    );
    const open = async () => {
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'ccAgent.gitContext.pr.manage.title' }));
      });
    };
    return {
      ...view,
      open,
      manage,
      statuses,
      invoke,
      statusFor,
      openExternal,
      addRef: (prNumber: number) => {
        refs = [
          ...refs,
          {
            ...refs[0],
            id: `manager-${prNumber}`,
            prNumber,
            url: `https://github.com/octo/repo/pull/${prNumber}`,
            pinned: false,
          },
        ];
      },
    };
  }

  // Unit regressions: hidden header PRs need an actionable list link, including
  // review tasks and removed/untitled refs. Earlier tests only read row text.
  it.each([false, true])(
    'opens PR links without exposing review-task mutations (%s)',
    async (readOnly) => {
      const f = fixture(undefined, 4, readOnly);
      await f.open();
      const panel = screen.getByRole('dialog');
      for (const [name, number] of [
        ['Title 4', 4],
        ['repo #3', 3],
      ] as const) {
        const link = screen.getByRole('link', { name });
        await act(async () => {
          fireEvent.click(link);
        });
        expect(f.openExternal).toHaveBeenLastCalledWith(
          `https://github.com/octo/repo/pull/${number}`,
        );
      }
      panel.querySelector('details')!.open = true;
      await act(async () => {
        fireEvent.click(screen.getByRole('link', { name: 'repo #5' }));
      });
      expect(f.openExternal).toHaveBeenLastCalledWith('https://github.com/octo/repo/pull/5');
      if (readOnly) {
        expect(screen.queryByRole('textbox')).toBeNull();
        expect(panel.querySelector('[data-pr-drag-handle]')).toBeNull();
        expect(
          screen
            .getAllByRole('button')
            .filter((b) => panel.contains(b))
            .map((b) => b.getAttribute('aria-label')),
        ).toEqual(['common.dismiss']);
        expect(managerMocks.sortables).toHaveLength(0);
        expect(f.manage.mock.calls.map(([op]) => op.action)).toEqual(['list']);
      }
    },
  );

  // Unit regression: adding a reference elsewhere invalidates the old complete
  // reorder group. Refresh must expose that row and permit the next retry.
  it('refreshes the group after rejected reorder and retains the retry explanation', async () => {
    const f = fixture();
    await f.open();
    f.addRef(9);
    f.manage.mockRejectedValueOnce(new Error('[INVALID_PARAMS] Incomplete group'));
    const move = async () =>
      act(async () => {
        fireEvent.keyDown(
          screen.getByRole('button', {
            name: 'ccAgent.gitContext.pr.manage.dragHandle {"repo":"repo","number":2}',
          }),
          { key: 'ArrowDown', altKey: true },
        );
      });
    await move();
    expect(f.manage.mock.calls.map(([op]) => op.action)).toEqual(['list', 'reorder', 'list']);
    expect(screen.getByRole('alert').textContent).toBe(
      'ccAgent.gitContext.pr.manage.errors.reorderFailed',
    );
    expect(screen.getByText('Title 9')).toBeTruthy();
    expect(f.statuses.mock.calls.at(-1)![0].map((q) => q.prNumber)).toEqual([9]);
    await move();
    expect(f.manage).toHaveBeenLastCalledWith({
      sessionId: dialogueSession.id,
      action: 'reorder',
      ids: ['manager-3', 'manager-2', 'manager-4', 'manager-9'],
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it.each([undefined, 'device-2'])(
    'queries all active titles once and falls back on failed status (%s)',
    async (deviceId) => {
      const f = fixture(deviceId);
      await f.open();
      expect(screen.getByText('Title 4').getAttribute('title')).toBe('Title 4');
      expect(screen.getByText('repo #3')).toBeTruthy();
      expect(screen.queryByText('Title 3')).toBeNull();
      expect(f.statuses.mock.calls[0][0].map((q) => q.prNumber)).toEqual([1, 2, 3, 4]);
      expect(f.statuses).toHaveBeenCalledTimes(1);
      if (deviceId)
        expect(f.invoke).toHaveBeenCalledWith(deviceId, 'git-context:pr-status', [
          {
            sessionId: dialogueSession.id,
            queries: [1, 2, 3, 4].map((prNumber) => ({ owner: 'octo', repo: 'repo', prNumber })),
          },
        ]);
      await act(async () => {
        fireEvent.click(
          screen.getByRole('button', {
            name: 'ccAgent.gitContext.pr.manage.restore',
            hidden: true,
          }),
        );
      });
      expect(f.statuses.mock.calls[1][0].map((q) => q.prNumber)).toEqual([5]);
      expect(screen.getByText('Title 5')).toBeTruthy();
    },
  );

  // Unit regression: main accepts at most ten queries. Twelve active rows
  // previously lost the last two titles. Deferred promises prove serial requests
  // and cancellation without real waits or source/constant assertions.
  it.each([undefined, 'device-2'])(
    'queries 12 rows in serial batches and stops after close (%s)',
    async (deviceId) => {
      const f = fixture(deviceId, 12);
      let resolve!: (statuses: PrStatusResult[]) => void;
      f.statuses.mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      );
      await f.open();
      expect(f.statuses).toHaveBeenCalledTimes(1);
      expect(f.statuses.mock.calls[0][0].map((q) => q.prNumber)).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
      ]);
      await act(async () => {
        resolve(f.statuses.mock.calls[0][0].map((q) => f.statusFor(q.prNumber)));
      });
      expect(f.statuses.mock.calls[1][0].map((q) => q.prNumber)).toEqual([11, 12]);
      expect(screen.getByText('Title 11')).toBeTruthy();
      expect(screen.getByText('Title 12')).toBeTruthy();
      expect(f.statuses).toHaveBeenCalledTimes(2);
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'common.dismiss' }));
      });
      f.statuses.mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      );
      await f.open();
      expect(f.statuses).toHaveBeenCalledTimes(3);
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'common.dismiss' }));
      });
      await act(async () => {
        resolve(f.statuses.mock.calls[2][0].map((q) => f.statusFor(q.prNumber)));
      });
      expect(f.statuses).toHaveBeenCalledTimes(3);
      expect(screen.queryByText('Title 11')).toBeNull();
    },
  );

  // Unit regression for PR #8092: management must bound GitHub status work to
  // the first 20 displayed active rows. The 12-row batching case misses the cap;
  // 21 rows is the minimum overflow, with 25 covering the requested two batches.
  it('limits status queries to 20 displayed rows and leaves overflow links usable', async () => {
    const f = fixture(undefined, 25);
    await f.open();
    expect(f.statuses.mock.calls.map(([queries]) => queries.map((q) => q.prNumber))).toEqual([
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      [11, 12, 13, 14, 15, 16, 17, 18, 19, 20],
    ]);
    expect(screen.getByRole('link', { name: 'Title 20' })).toBeTruthy();
    for (const number of [21, 22, 23, 24, 25]) {
      expect(screen.getByRole('link', { name: `repo #${number}` })).toBeTruthy();
      expect(screen.queryByText(`Title ${number}`)).toBeNull();
    }
    await act(async () => {
      fireEvent.click(screen.getByRole('link', { name: 'repo #21' }));
      fireEvent.click(
        screen.getByRole('button', {
          name: 'ccAgent.gitContext.pr.manage.restore',
          hidden: true,
        }),
      );
    });
    expect(f.openExternal).toHaveBeenLastCalledWith('https://github.com/octo/repo/pull/21');
    expect(f.statuses).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('link', { name: 'repo #26' })).toBeTruthy();

    const list = managerMocks.sortables.find((item) =>
      item.element.querySelector('[data-sortable-id="manager-26"]'),
    )!;
    await act(async () => {
      const moved = list.element.lastElementChild as HTMLElement;
      list.element.prepend(moved);
      (list.options.onEnd as (event: unknown) => void)({
        item: moved,
        from: list.element,
        oldIndex: 24,
        newIndex: 0,
      });
    });
    expect(f.statuses.mock.calls[2][0].map((q) => q.prNumber)).toEqual([26]);
    expect(screen.getByRole('link', { name: 'Title 26' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'repo #20' })).toBeTruthy();
    expect(screen.queryByText('Title 20')).toBeNull();
  });

  it('continues with the next batch after a silent status failure', async () => {
    const f = fixture(undefined, 12);
    f.statuses.mockRejectedValueOnce(new Error('offline'));
    await f.open();
    expect(screen.getByText('repo #1')).toBeTruthy();
    expect(screen.getByText('Title 12')).toBeTruthy();
    expect(f.statuses).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('handle-only reorder keeps keyboard focus and excludes removed rows', async () => {
    const f = fixture();
    await f.open();
    const handleName = (number: number) =>
      `ccAgent.gitContext.pr.manage.dragHandle {"repo":"repo","number":${number}}`;
    const handle = screen.getByRole('button', { name: handleName(2) });
    const row = handle.closest('[data-sortable-id]')!.firstElementChild as HTMLElement;
    expect(row.tabIndex).toBe(-1);
    expect(screen.queryByRole('button', { name: handleName(5), hidden: true })).toBeNull();
    await act(async () => {
      fireEvent.keyDown(row, { key: 'ArrowDown', altKey: true });
      fireEvent.click(handle);
    });
    expect(f.manage).toHaveBeenCalledTimes(1);
    const applyReorder = f.manage.getMockImplementation()!;
    let finishReorder!: () => void;
    const pendingReorder = new Promise<void>((resolve) => {
      finishReorder = resolve;
    });
    f.manage.mockImplementationOnce(async (action) => {
      await pendingReorder;
      return applyReorder(action);
    });
    await act(async () => {
      handle.focus();
    });
    await act(async () => {
      fireEvent.keyDown(handle, { key: 'ArrowDown', altKey: true });
    });
    expect(f.manage).toHaveBeenLastCalledWith({
      sessionId: dialogueSession.id,
      action: 'reorder',
      ids: ['manager-3', 'manager-2', 'manager-4'],
    });
    await act(async () => {
      finishReorder();
    });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: handleName(2) }));
    expect(f.statuses).toHaveBeenCalledTimes(1);
    const pinned = screen.getByRole('button', { name: handleName(1) });
    await act(async () => {
      fireEvent.keyDown(pinned, { key: 'ArrowDown', altKey: true });
    });
    expect(f.manage).toHaveBeenCalledTimes(2);
    const list = managerMocks.sortables.find((item) =>
      item.element.querySelector('[data-sortable-id="manager-3"]'),
    )!;
    const moved = list.element.children[0] as HTMLElement;
    const currentHandle = screen.getByRole('button', { name: handleName(3) });
    // Resolve the actual Sortable options against rendered controls: the handle
    // is eligible, while title and action buttons cannot initiate a drag.
    expect(currentHandle.matches(list.options.handle as string)).toBe(true);
    expect(currentHandle.closest(list.options.filter as string)).toBeNull();
    expect(screen.getByText('repo #3').closest(list.options.handle as string)).toBeNull();
    expect(moved.querySelector('button')!.matches(list.options.filter as string)).toBe(true);
    // Exercise the real SortableList DOM rollback + persisted callback path.
    await act(async () => {
      list.element.append(moved);
      (list.options.onEnd as (event: unknown) => void)({
        item: moved,
        from: list.element,
        oldIndex: 0,
        newIndex: 2,
      });
    });
    expect(f.manage).toHaveBeenLastCalledWith({
      sessionId: dialogueSession.id,
      action: 'reorder',
      ids: ['manager-2', 'manager-4', 'manager-3'],
    });
  });

  // Unit regression: a rejected reorder must retain persisted order and report
  // the attempted action, not the old combined URL/pin error. Exercise the real
  // Sortable rollback and keyboard path against one INVALID_PARAMS response.
  it('keeps the saved order on failure and explains reorder, add and pin errors separately', async () => {
    const f = fixture();
    await f.open();
    const failure = () => new Error('[INVALID_PARAMS] Unknown PR action');
    const order = () =>
      Array.from(screen.getByRole('dialog').querySelectorAll('[data-sortable-id]')).map((row) =>
        row.getAttribute('data-sortable-id'),
      );
    const original = order();
    const list = managerMocks.sortables.find((item) =>
      item.element.querySelector('[data-sortable-id="manager-2"]'),
    )!;
    f.manage.mockRejectedValueOnce(failure());
    await act(async () => {
      const moved = list.element.children[0] as HTMLElement;
      list.element.append(moved);
      (list.options.onEnd as (event: unknown) => void)({
        item: moved,
        from: list.element,
        oldIndex: 0,
        newIndex: 2,
      });
    });
    expect(screen.getByRole('alert').textContent).toBe(
      'ccAgent.gitContext.pr.manage.errors.reorderFailed',
    );
    expect(order()).toEqual(original);
    f.manage.mockRejectedValueOnce(failure());
    await act(async () => {
      fireEvent.keyDown(
        screen.getByRole('button', {
          name: 'ccAgent.gitContext.pr.manage.dragHandle {"repo":"repo","number":2}',
        }),
        { key: 'ArrowDown', altKey: true },
      );
    });
    expect(screen.getByRole('alert').textContent).toBe(
      'ccAgent.gitContext.pr.manage.errors.reorderFailed',
    );
    expect(order()).toEqual(original);

    f.manage.mockRejectedValueOnce(failure());
    await act(async () => {
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'not a PR URL' } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'ccAgent.gitContext.pr.manage.add' }));
    });
    expect(screen.getByRole('alert').textContent).toBe(
      'ccAgent.gitContext.pr.manage.errors.invalidUrl',
    );
    f.manage.mockRejectedValueOnce(failure());
    await act(async () => {
      fireEvent.click(
        screen.getAllByRole('button', { name: 'ccAgent.gitContext.pr.manage.pin' })[0],
      );
    });
    expect(screen.getByRole('alert').textContent).toBe('ccAgent.gitContext.pr.manage.pinLimit');

    f.manage.mockRejectedValueOnce(new Error('[DEVICE_LINK_CHANNEL_NOT_ALLOWED] unavailable'));
    await act(async () => {
      fireEvent.keyDown(
        screen.getByRole('button', {
          name: 'ccAgent.gitContext.pr.manage.dragHandle {"repo":"repo","number":2}',
        }),
        { key: 'ArrowDown', altKey: true },
      );
    });
    expect(screen.getByRole('alert').textContent).toBe(
      'ccAgent.gitContext.pr.manage.errors.unsupported',
    );
    expect(order()).toEqual(original);
  });

  // Unit regression for PR #8092: closing before a remote mutation resolves
  // must not suppress cache invalidation. Existing late-result coverage only
  // queries titles; a deferred pin plus a newer list exposes both effects.
  it('invalidates the original remote session after close without replacing a newer list', async () => {
    const f = fixture('device-2');
    await f.open();
    const originalRows: SessionPrRef[] = await f.manage.mock.results[0].value;
    let finishPin!: (rows: SessionPrRef[]) => void;
    f.manage.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishPin = resolve;
        }),
    );
    await act(async () => {
      fireEvent.click(
        screen.getAllByRole('button', { name: 'ccAgent.gitContext.pr.manage.pin' })[0],
      );
    });
    expect(f.manage).toHaveBeenLastCalledWith({
      sessionId: dialogueSession.id,
      action: 'pin',
      id: 'manager-2',
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'common.dismiss' }));
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(managerMocks.invalidate).not.toHaveBeenCalled();
    f.addRef(9);
    await f.open();
    expect(screen.getByRole('link', { name: 'Title 9' })).toBeTruthy();
    await act(async () => {
      finishPin(
        originalRows.map((row) => (row.id === 'manager-2' ? { ...row, pinned: true } : row)),
      );
    });
    expect(managerMocks.invalidate).toHaveBeenCalledExactlyOnceWith(dialogueSession.id);
    expect(screen.getByRole('link', { name: 'Title 9' })).toBeTruthy();
    expect(f.statuses).toHaveBeenCalledTimes(2);
  });

  it('discards late title results after close and reopens with a fresh request', async () => {
    const f = fixture();
    let resolve!: (statuses: PrStatusResult[]) => void;
    f.statuses.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await f.open();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'common.dismiss' }));
    });
    await f.open();
    expect(screen.getByText('Title 4')).toBeTruthy();
    await act(async () => {
      resolve([{ ...f.statusFor(4), title: 'Stale title' } as PrStatusResult]);
    });
    expect(screen.queryByText('Stale title')).toBeNull();
    expect(screen.getByText('Title 4')).toBeTruthy();
    expect(f.statuses).toHaveBeenCalledTimes(2);
  });
});
