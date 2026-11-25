// @vitest-environment jsdom
/**
 * Unit (DOM): the old DAG body unmounted the title registration, losing the only close control.
 * Existing drag/menu guards don't exercise a mounted shell. Use the real registration and slot;
 * only the unrelated desktop services and badges are isolated.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { FeatureSidebarSlotProvider, useFeatureContentHeader } from '../../feature-context';
import { SessionContentHeaderRegistration, useSessionDagToggle } from '../SessionContentHeader';
import type { Session } from '@/lib/ccAgent.types';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../sidebar/SessionTaskMenu', () => ({ SessionTaskMenu: () => null }));
vi.mock('../TaskMigrationStatus', () => ({ TaskMigrationStatus: () => null }));
vi.mock('../GitContextBadge', () => ({ GitContextBadge: () => null }));
vi.mock('../OrcaRemoteLeadBadge', () => ({ OrcaRemoteLeadBadge: () => null }));
vi.mock('@/features/bots/BotTaskOwnerChip', () => ({ BotTaskOwnerChip: () => null }));
vi.mock('@/cindy-brain/PluginUiContributions', () => ({ PluginUiSlot: () => null, PluginUiMenu: () => null }));
vi.mock('@/hooks/useCCSessions', () => ({ useCCSessions: () => ({ sessions: [] }) }));
vi.mock('@/hooks/useProjectPickerOptions', () => ({ useProjectPickerOptions: () => [] }));
vi.mock('@/hooks/useSessionRunningStatus', () => ({ useSessionRunningStatus: () => ({ runningSessionIds: new Set() }) }));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({ useConfirmDialog: () => ({}) }));
vi.mock('../hooks/useConfirmTaskArchive', () => ({ useConfirmTaskArchive: () => vi.fn() }));
vi.mock('../hooks/useSessionLifecycleActions', () => ({ useSessionLifecycleActions: () => ({}) }));
vi.mock('@/features/scheduler/lib/scheduleSessionBinding', () => ({ useSessionBoundSchedules: () => [] }));
vi.mock('@/features/device-link/remoteProjectsStore', () => ({ useRemoteProjectSessions: () => [] }));

afterEach(cleanup);
const task = { id: 'a', userId: 'owner', title: '发布计划', workspaceKind: 'dialogue' } as Session;
function ShellTitle() {
  return <header data-route={useLocation().pathname}>{useFeatureContentHeader()}</header>;
}
function TaskTitle({ current, enabled }: { current: Session; enabled: boolean }) {
  const toggle = useSessionDagToggle(enabled ? current : null);
  return <SessionContentHeaderRegistration session={current} dagToggle={toggle} />;
}
function shell(current: Session | null, enabled = true) {
  return <MemoryRouter initialEntries={['/cc-agent/a']}>
    <FeatureSidebarSlotProvider isCollapsed={false}>
      <ShellTitle />
      {current && <TaskTitle current={current} enabled={enabled} />}
    </FeatureSidebarSlotProvider>
  </MemoryRouter>;
}
const dag = () => screen.getByRole('button', { name: 'DAG' });
const menu = () => screen.getByRole('button', { name: 'ccAgent.sessionHeader.moreActions' });

describe('session title DAG toggle', () => {
  it('keeps the same title, menu and toggle across open/close, without navigating', () => {
    render(shell(task));
    const button = dag(), more = menu(), title = screen.getByTitle(task.title);
    expect(button.nextElementSibling).toBe(more);
    expect((button.style as CSSStyleDeclaration & { WebkitAppRegion?: string }).WebkitAppRegion).toBe('no-drag');
    for (const pressed of [true, false]) {
      fireEvent.click(button);
      expect(dag()).toBe(button);
      expect(button.getAttribute('aria-pressed')).toBe(String(pressed));
      expect(menu()).toBe(more);
      expect(screen.getByTitle(task.title)).toBe(title);
      expect(title.closest('header')?.dataset.route).toBe('/cc-agent/a');
    }
  });

  it('does not leak open state into another task or resurrect it after disabling the plugin', () => {
    const view = render(shell(task));
    fireEvent.click(dag());
    const other = { ...task, id: 'b', title: '项目复盘' };
    view.rerender(shell(other));
    expect(dag().getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(dag());
    view.rerender(shell(other, false));
    expect(screen.queryByRole('button', { name: 'DAG' })).toBeNull();
    expect(screen.getByTitle(other.title)).toBeTruthy();
    view.rerender(shell(other));
    expect(dag().getAttribute('aria-pressed')).toBe('false');
    view.rerender(shell(null));
    expect(screen.getByRole('banner').childElementCount).toBe(0);
  });
});
