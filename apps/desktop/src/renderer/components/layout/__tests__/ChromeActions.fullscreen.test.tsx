// @vitest-environment jsdom
/**
 * 测试价值
 * - 生产入口与可观察结果:真实 ChromeActions（左上按钮簇）/ SessionHistoryButtons
 *   与真实 hook（useSessionBrowseHistory）。可观察结果是按钮可用/置灰、tooltip
 *   文案，以及点击与 ⌘[ / ⌘] 之后路由落在哪个任务。
 * - Bug / 规则依据:新功能「任务浏览栈」—— 没有上一个/下一个任务时置灰并说明原因
 *   （DESIGN §14.6）；后退/前进按浏览器语义走栈；栈外页面后退先回最近任务；
 *   打不开的历史目标要摘掉，不能把用户送进死路；快捷键与按钮同一份栈。
 * - 现有覆盖缺口:原文件只覆盖 fullscreen 兜底；这里补历史导航（同模块用例并入，
 *   不另起收集单元）。
 * - 最小失败输入:在 /cc-agent/a 断言后退可用（应为否）；或从草稿页后退直接落到
 *   A（应回到最近的 B）。
 * - tier:unit（jsdom，MemoryRouter + 真实 registry 组合键）。
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

const fullscreenState = vi.hoisted(() => ({ isMac: true, isFullscreen: true }));
/** 任务删除广播的来源(sessionsStore.patchLocal 的回调)。 */
const sessionPatches = vi.hoisted(() => {
  type Listener = (id: string, patch: { status?: string }, row: null) => void;
  const listeners = new Set<Listener>();
  return {
    emit(id: string, patch: { status?: string }) {
      for (const listener of listeners) listener(id, patch, null);
    },
    subscribePatches(listener: Listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    clear() {
      listeners.clear();
    },
  };
});

/** 被控端任务删除的来源(它们不经过本机 sessionsStore)。 */
const remoteRemovals = vi.hoisted(() => {
  type Listener = (sessionId: string) => void;
  const listeners = new Set<Listener>();
  return {
    emit(sessionId: string) {
      for (const listener of listeners) listener(sessionId);
    },
    subscribe(listener: Listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    clear() {
      listeners.clear();
    },
  };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/hooks/useMacFullscreen', () => ({
  useMacFullscreen: () => fullscreenState,
}));
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ dataOwnerId: 'owner-a', dataOwnerRecoveryEpoch: 1 }),
}));
vi.mock('@/lib/sessionsStore', () => ({
  sessionsStore: { subscribePatches: sessionPatches.subscribePatches },
}));
vi.mock('@/features/device-link/remoteProjectsStore', () => ({
  subscribeRemoteSessionRemoval: remoteRemovals.subscribe,
}));
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children, onSelect }: { children: ReactNode; onSelect?: () => void }) => (
    <button onClick={onSelect}>{children}</button>
  ),
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

import { ChromeActions, SessionHistoryButtons } from '../ChromeActions';
import {
  formatAppShortcutCombo,
  getEffectiveAppShortcuts,
  type AppShortcutId,
} from '../../../../shared/appShortcuts';
import { createSessionBrowseHistory } from '@/features/cc-agent/sessionBrowseHistory';
import type { SessionBrowseHistory } from '@/features/cc-agent/sessionBrowseHistory';
import { useSessionBrowseHistory } from '@/features/cc-agent/useSessionBrowseHistory';
import { getAppShortcutPlatform } from '@/lib/appShortcutStore';

vi.mock('@/features/device-link/useSharedTaskTasks', () => ({ useSharedTaskTasks: vi.fn() }));
vi.mock('@/features/device-link/JoinSharedTaskDialog', () => ({ JoinSharedTaskDialog: () => null }));
vi.mock('@/features/device-link/SharedTaskEndedNotice', () => ({ SharedTaskEndedNotice: () => null }));
// MenuButton shows the pending-approval count; keep the chat store (and its i18n bootstrap) out of this test.
vi.mock('@/features/approvals/useApprovalSessionIds', () => ({ useApprovalSessionIds: () => [] }));

afterEach(() => {
  cleanup();
  fullscreenState.isMac = true;
  fullscreenState.isFullscreen = true;
  sessionPatches.clear();
  remoteRemovals.clear();
  delete (window as Partial<Window>).electronAPI;
});

describe('ChromeActions fullscreen fallback', () => {
  // 浏览栈现在由常驻壳层持有，按钮簇只接收它的快照；这组用例与浏览无关。
  const idleBrowseHistory = {
    canBack: false,
    canForward: false,
    goBack: () => false,
    goForward: () => false,
  };

  it('lets a macOS user exit fullscreen when native traffic lights are unavailable', () => {
    const windowExitFullscreen = vi.fn();
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { windowExitFullscreen } as Partial<Window['electronAPI']>,
    });

    render(
      <MemoryRouter>
        <ChromeActions isSidebarCollapsed={false} onToggleSidebar={vi.fn()} browseHistory={idleBrowseHistory} />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'contentHeader.exitFullscreen' }));

    expect(windowExitFullscreen).toHaveBeenCalledOnce();
  });

  it('does not show the fallback outside macOS fullscreen', () => {
    fullscreenState.isFullscreen = false;

    render(
      <MemoryRouter>
        <ChromeActions isSidebarCollapsed={false} onToggleSidebar={vi.fn()} browseHistory={idleBrowseHistory} />
      </MemoryRouter>,
    );

    expect(screen.queryByRole('button', { name: 'contentHeader.exitFullscreen' })).toBeNull();
  });
});

function PathLabel(): React.ReactElement {
  const { pathname } = useLocation();
  return <span data-testid="path">{pathname}</span>;
}

function OpenTask({ id }: { id: string }): React.ReactElement {
  const navigate = useNavigate();
  return <button onClick={() => navigate(`/cc-agent/${id}`)}>{`open ${id}`}</button>;
}

function OpenDraft(): React.ReactElement {
  const navigate = useNavigate();
  return <button onClick={() => navigate('/cc-agent/new')}>open draft</button>;
}

function Harness({ history }: { history: SessionBrowseHistory }): React.ReactElement {
  return (
    <>
      <SessionHistoryButtons {...useSessionBrowseHistory({ history })} />
      <PathLabel />
      <OpenTask id="b" />
      <OpenTask id="c" />
      <OpenDraft />
      {/* CodeMirror 文件编辑器的真实 DOM 形状(FileBodyView 的 PlaintextEditor)。 */}
      <div className="cm-editor">
        <div className="cm-content" contentEditable suppressContentEditableWarning />
      </div>
    </>
  );
}

function renderAt(pathname: string): SessionBrowseHistory {
  const history = createSessionBrowseHistory();
  render(
    <MemoryRouter initialEntries={[pathname]}>
      <Harness history={history} />
    </MemoryRouter>,
  );
  return history;
}

function defaultCombo(id: AppShortcutId) {
  const platform = getAppShortcutPlatform();
  const combo = getEffectiveAppShortcuts({}, platform).get(id)?.[0];
  if (!combo) throw new Error(`no default combo for ${id}`);
  return { platform, combo };
}

function keyInit(combo: { code: string; meta: boolean; ctrl: boolean; alt: boolean; shift: boolean }) {
  return {
    code: combo.code,
    metaKey: combo.meta,
    ctrlKey: combo.ctrl,
    altKey: combo.alt,
    shiftKey: combo.shift,
  };
}

function press(combo: Parameters<typeof keyInit>[0]) {
  fireEvent.keyDown(window, keyInit(combo));
}

describe('session browse history buttons', () => {
  it('greys both directions out on the first task and says why', () => {
    renderAt('/cc-agent/a');

    expect(screen.getByTestId('path').textContent).toBe('/cc-agent/a');
    expect(
      screen
        .getByRole('button', { name: 'titleBar.historyBackUnavailable' })
        .getAttribute('aria-disabled'),
    ).toBe('true');
    expect(
      screen
        .getByRole('button', { name: 'titleBar.historyForwardUnavailable' })
        .getAttribute('aria-disabled'),
    ).toBe('true');
  });

  it('walks back to the previous task and forward again, state following the stack', async () => {
    const user = userEvent.setup();
    renderAt('/cc-agent/a');

    await user.click(screen.getByRole('button', { name: 'open b' }));
    expect(screen.getByTestId('path').textContent).toBe('/cc-agent/b');

    const back = screen.getByRole('button', { name: 'titleBar.historyBack' });
    expect(back.hasAttribute('disabled')).toBe(false);

    await user.click(back);
    expect(screen.getByTestId('path').textContent).toBe('/cc-agent/a');
    expect(screen.getByRole('button', { name: 'titleBar.historyBackUnavailable' })).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'titleBar.historyForward' }));
    expect(screen.getByTestId('path').textContent).toBe('/cc-agent/b');
    expect(screen.getByRole('button', { name: 'titleBar.historyForwardUnavailable' })).toBeTruthy();
  });

  it('drops the forward side when a different task opens after going back', async () => {
    const user = userEvent.setup();
    renderAt('/cc-agent/a');

    await user.click(screen.getByRole('button', { name: 'open b' }));
    await user.click(screen.getByRole('button', { name: 'open c' }));
    await user.click(screen.getByRole('button', { name: 'titleBar.historyBack' }));
    expect(screen.getByTestId('path').textContent).toBe('/cc-agent/b');

    await user.click(screen.getByRole('button', { name: 'open c' }));
    expect(screen.getByTestId('path').textContent).toBe('/cc-agent/c');
    expect(screen.getByRole('button', { name: 'titleBar.historyForwardUnavailable' })).toBeTruthy();
  });

  it('returns to the most recent task first when going back from a page outside the stack', async () => {
    const user = userEvent.setup();
    renderAt('/cc-agent/a');

    await user.click(screen.getByRole('button', { name: 'open b' }));
    await user.click(screen.getByRole('button', { name: 'open draft' }));
    expect(screen.getByTestId('path').textContent).toBe('/cc-agent/new');

    const back = screen.getByRole('button', { name: 'titleBar.historyBack' });
    expect(back.hasAttribute('disabled')).toBe(false);
    await user.click(back);
    expect(screen.getByTestId('path').textContent).toBe('/cc-agent/b');

    await user.click(screen.getByRole('button', { name: 'titleBar.historyBack' }));
    expect(screen.getByTestId('path').textContent).toBe('/cc-agent/a');
  });

  it('forgets a task as soon as it is deleted instead of offering it again', async () => {
    const user = userEvent.setup();
    renderAt('/cc-agent/a');

    await user.click(screen.getByRole('button', { name: 'open b' }));
    act(() => sessionPatches.emit('a', { status: 'deleted' }));

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'titleBar.historyBackUnavailable' }),
      ).toBeTruthy(),
    );
    expect(screen.getByTestId('path').textContent).toBe('/cc-agent/b');
  });

  it('forgets a task deleted on the device it runs on', async () => {
    const user = userEvent.setup();
    renderAt('/cc-agent/a');

    await user.click(screen.getByRole('button', { name: 'open b' }));
    // 被控端任务不走 sessionsStore 广播,只会报一条「已消失」。
    act(() => remoteRemovals.emit('a'));

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'titleBar.historyBackUnavailable' }),
      ).toBeTruthy(),
    );
    expect(screen.getByTestId('path').textContent).toBe('/cc-agent/b');
  });

  it('names the shortcut in the tooltip', async () => {
    const user = userEvent.setup();
    renderAt('/cc-agent/a');
    await user.click(screen.getByRole('button', { name: 'open b' }));

    const { platform, combo } = defaultCombo('session-history-back');
    await user.hover(screen.getByRole('button', { name: 'titleBar.historyBack' }));

    expect((await screen.findByRole('tooltip')).textContent).toBe(
      `titleBar.historyBack (${formatAppShortcutCombo(combo, platform)})`,
    );
  });

  it('walks the same stack from the keyboard shortcut', async () => {
    renderAt('/cc-agent/a');
    fireEvent.click(screen.getByRole('button', { name: 'open b' }));
    expect(screen.getByTestId('path').textContent).toBe('/cc-agent/b');

    press(defaultCombo('session-history-back').combo);
    await waitFor(() => expect(screen.getByTestId('path').textContent).toBe('/cc-agent/a'));

    press(defaultCombo('session-history-forward').combo);
    await waitFor(() => expect(screen.getByTestId('path').textContent).toBe('/cc-agent/b'));
  });

  it('leaves the bracket shortcut to the file editor that owns it', async () => {
    renderAt('/cc-agent/a');
    fireEvent.click(screen.getByRole('button', { name: 'open b' }));
    expect(screen.getByTestId('path').textContent).toBe('/cc-agent/b');

    // 焦点在 CodeMirror 里 → Mod-[ / Mod-] 是缩进命令,不能拿去导航(会丢掉刚改的内容)。
    const editorContent = document.querySelector('.cm-content') as HTMLElement;
    fireEvent.keyDown(editorContent, keyInit(defaultCombo('session-history-back').combo));
    expect(screen.getByTestId('path').textContent).toBe('/cc-agent/b');

    // 焦点回到普通页面 → 同一个组合照旧导航。
    press(defaultCombo('session-history-back').combo);
    await waitFor(() => expect(screen.getByTestId('path').textContent).toBe('/cc-agent/a'));
  });
});
