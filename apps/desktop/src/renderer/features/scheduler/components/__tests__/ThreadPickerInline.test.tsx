// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  list: vi.fn(async () => []),
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

    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('option', { selected: true }).textContent).toBe(
      'scheduler.editor.thread.deletedBinding',
    );
    expect(
      screen.queryByRole('button', { name: 'scheduler.editor.runSession.card.open' }),
    ).toBeNull();
  });
});
