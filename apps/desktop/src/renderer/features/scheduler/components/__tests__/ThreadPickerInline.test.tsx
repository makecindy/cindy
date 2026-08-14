// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  list: vi.fn(
    async () =>
      [] as Array<{
        id: string;
        title: string;
        agentKind: 'cc' | 'codex' | 'pi';
        source?: string;
      }>,
  ),
}));

vi.mock('@/lib/sessionService', () => ({ list: mocks.list }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
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
