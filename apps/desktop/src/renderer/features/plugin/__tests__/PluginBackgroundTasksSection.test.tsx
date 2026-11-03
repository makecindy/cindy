/**
 * 插件详情页「后台任务」区块:声明 hiddenTasks 时的列表/空状态、未声明时不占位、
 * 打开任务走 /cc-agent 路由、「显示到任务列表」调用宿主 IPC 并刷新。
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  patchListeners: new Set<(id: string, patch: Record<string, unknown>) => void>(),
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options?.time !== undefined ? `${key}:${String(options.time)}` : key,
  }),
}));
vi.mock('@/lib/toast', () => ({ toast: h.toast }));
vi.mock('@/lib/sessionsStore', () => ({
  sessionsStore: {
    subscribePatches: (fn: (id: string, patch: Record<string, unknown>) => void) => {
      h.patchListeners.add(fn);
      return () => h.patchListeners.delete(fn);
    },
  },
}));

import { PluginBackgroundTasksSection } from '../PluginBackgroundTasksSection';

const listBackgroundTasks = vi.fn();
const revealBackgroundTask = vi.fn();

function Location() {
  const location = useLocation();
  return <span data-testid="location">{location.pathname}</span>;
}

function renderSection(props: { installed?: boolean; hiddenTasksDeclared?: boolean } = {}) {
  return render(
    <MemoryRouter initialEntries={['/plugins/demo']}>
      <Routes>
        <Route path="*" element={(
          <>
            <PluginBackgroundTasksSection
              ghostId="demo"
              installed={props.installed ?? true}
              hiddenTasksDeclared={props.hiddenTasksDeclared ?? true}
            />
            <Location />
          </>
        )} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  h.patchListeners.clear();
  listBackgroundTasks.mockReset();
  revealBackgroundTask.mockReset();
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    ghosts: { listBackgroundTasks, revealBackgroundTask },
  };
});
afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe('PluginBackgroundTasksSection', () => {
  it('lists hidden tasks with status and last activity, opens them by route and reveals them', async () => {
    listBackgroundTasks.mockResolvedValueOnce({ items: [
      { taskId: 'run-1', title: 'Nightly grading', status: 'active', updatedAt: Date.now() - 5 * 60_000, running: true },
      { taskId: 'old-1', title: 'Old batch', status: 'archived', updatedAt: Date.now() - 2 * 3_600_000, running: false },
    ] });
    renderSection();
    expect(await screen.findByText('Nightly grading')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'settings.ghosts.backgroundTasks.title' })).toBeTruthy();
    expect(screen.getAllByTestId('plugin-background-task')).toHaveLength(2);
    expect(screen.getByText(/settings\.ghosts\.backgroundTasks\.statusRunning/)).toBeTruthy();
    expect(screen.getByText(/settings\.ghosts\.backgroundTasks\.statusArchived/)).toBeTruthy();
    expect(screen.getAllByText(/settings\.ghosts\.backgroundTasks\.lastActive:/)).toHaveLength(2);
    expect(listBackgroundTasks).toHaveBeenCalledWith('demo');

    fireEvent.click(screen.getAllByRole('button', { name: 'settings.ghosts.backgroundTasks.open' })[0]);
    expect(screen.getByTestId('location').textContent).toBe('/cc-agent/run-1');

    revealBackgroundTask.mockResolvedValueOnce({ ok: true });
    listBackgroundTasks.mockResolvedValueOnce({ items: [] });
    fireEvent.click(screen.getAllByRole('button', { name: 'settings.ghosts.backgroundTasks.reveal' })[1]);
    await waitFor(() => expect(revealBackgroundTask).toHaveBeenCalledWith('demo', 'old-1'));
    await waitFor(() => expect(screen.getByText('settings.ghosts.backgroundTasks.empty')).toBeTruthy());
    expect(h.toast.success).toHaveBeenCalledWith('settings.ghosts.backgroundTasks.revealed');
  });

  it('shows the empty state when the plugin declares background tasks but has none', async () => {
    listBackgroundTasks.mockResolvedValue({ items: [] });
    renderSection();
    expect(await screen.findByText('settings.ghosts.backgroundTasks.empty')).toBeTruthy();
  });

  it('refreshes when a hiddenAt patch arrives', async () => {
    listBackgroundTasks.mockResolvedValueOnce({ items: [] });
    renderSection();
    await screen.findByText('settings.ghosts.backgroundTasks.empty');
    listBackgroundTasks.mockResolvedValueOnce({ items: [
      { taskId: 'new-1', title: 'Fresh background', status: 'active', updatedAt: Date.now(), running: false },
    ] });
    for (const listener of h.patchListeners) listener('other', { title: 'x' });
    expect(listBackgroundTasks).toHaveBeenCalledTimes(1);
    for (const listener of h.patchListeners) listener('new-1', { hiddenAt: new Date().toISOString() });
    expect(await screen.findByText('Fresh background')).toBeTruthy();
  });

  it('stays out of the page without background tasks and never queries for uninstalled market views', async () => {
    listBackgroundTasks.mockResolvedValue({ items: [] });
    const { container } = renderSection({ hiddenTasksDeclared: false });
    await waitFor(() => expect(listBackgroundTasks).toHaveBeenCalled());
    expect(container.querySelector('section')).toBeNull();
    listBackgroundTasks.mockClear();
    const other = renderSection({ installed: false, hiddenTasksDeclared: false });
    expect(other.container.querySelector('section')).toBeNull();
    expect(listBackgroundTasks).not.toHaveBeenCalled();
  });

  it('still discloses leftover background tasks after the declaration was removed', async () => {
    listBackgroundTasks.mockResolvedValue({ items: [
      { taskId: 'left-1', title: 'Left behind', status: 'active', updatedAt: Date.now(), running: false },
    ] });
    renderSection({ hiddenTasksDeclared: false });
    expect(await screen.findByText('Left behind')).toBeTruthy();
  });
});
