// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  list: vi.fn(
    async () =>
      [] as Array<{
        id: string;
        title: string;
        agentKind: 'cc' | 'codex' | 'pi';
        source?: string;
        orcaLeadSessionId?: string;
      }>,
  ),
}));

vi.mock('@/lib/sessionService', () => ({ list: mocks.list }));
// These cases mount the task picker only; model location state is unrelated.
vi.mock('@/hooks/useModelRouteDevices', () => ({ useModelRouteDevices: () => ({ devices: undefined }) }));
// The shared-quota rail observes auth; this component fixture has no auth host.
vi.mock('@/contexts/AuthContext', () => ({ useOptionalAuthUser: () => null }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  // ScheduleChips 经模型面板的远程位置候选间接加载 i18n 初始化。
  initReactI18next: { type: '3rdParty', init: () => undefined },
}));

import { ThreadPickerInline } from '../ScheduleChips';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ThreadPickerInline 会话引用状态', () => {
  it('does not offer Review tasks as scheduler targets', async () => {
    mocks.list.mockResolvedValueOnce([
      { id: 'session-review', title: 'Review task', agentKind: 'codex', source: 'review' },
      { id: 'session-normal', title: 'Desktop task', agentKind: 'codex', source: 'desktop' },
    ]);

    render(<ThreadPickerInline value="" onSelect={vi.fn()} />);

    expect(await screen.findByRole('option', { name: 'Desktop task · Codex' })).toBeDefined();
    expect(screen.queryByRole('option', { name: 'Review task · Codex' })).toBeNull();
  });

  // Issue 2769 (unit): the production picker must distinguish identical Worker labels
  // while returning the chosen Worker ID. Filtering and deleted-binding tests
  // do not cover two same-title, same-engine Workers with different Leads.
  // Standalone Vitest run: 2.89 s.
  it('shows the owning Lead for same-name Workers and selects the original Worker', async () => {
    mocks.list.mockResolvedValueOnce([
      { id: 'worker-a', title: 'Analyst', agentKind: 'codex', orcaLeadSessionId: 'lead-a' },
      { id: 'worker-b', title: 'Analyst', agentKind: 'codex', orcaLeadSessionId: 'lead-b' },
      { id: 'worker-unmapped', title: 'Unmapped analyst', agentKind: 'codex', orcaLeadSessionId: 'lead-missing' },
      { id: 'lead-b', title: 'Lead Beacon', agentKind: 'codex' },
      { id: 'lead-a', title: 'Lead Atlas', agentKind: 'codex' },
    ]);
    const onSelect = vi.fn();
    render(<ThreadPickerInline value="" onSelect={onSelect} />);

    const picker = await screen.findByRole('combobox', { name: 'scheduler.editor.thread.label' });
    const atlas = screen.getByRole<HTMLOptionElement>('option', { name: 'Analyst · Codex · Lead Atlas' });
    const beacon = screen.getByRole<HTMLOptionElement>('option', { name: 'Analyst · Codex · Lead Beacon' });
    expect(screen.getByRole('option', { name: 'Unmapped analyst · Codex' })).toBeDefined();

    fireEvent.change(picker, { target: { value: atlas.value } });
    expect(onSelect).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'worker-a' }));
    fireEvent.change(picker, { target: { value: beacon.value } });
    expect(onSelect).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'worker-b' }));
  });

  it('普通绑定会话被删除后要求重新选择且不再显示打开入口', async () => {
    render(
      <ThreadPickerInline
        value="session-deleted"
        onSelect={vi.fn()}
        onOpen={vi.fn()}
        reference={{
          sessionId: 'session-deleted',
          state: 'deleted',
          status: 'deleted',
          agentKind: 'codex',
        }}
      />,
    );

    await screen.findByRole('option', {
      name: 'scheduler.editor.thread.deletedBinding',
      selected: true,
    });

    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole('button', { name: 'scheduler.editor.runSession.card.open' }),
    ).toBeNull();
  });
});
