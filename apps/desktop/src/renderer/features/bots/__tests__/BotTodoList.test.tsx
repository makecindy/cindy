// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { TeammateTodo } from '@cindy/maker-shared/teammate-todo';
import { TodoPanel, type TodoTransport } from '../BotTodoList';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
// Radix 浮层在 jsdom 里不真的开合:菜单摊平成按钮,确认框只在 open 时渲染标题与两个按钮。
vi.mock('@/components/ui/dropdown-menu', () => {
  const Pass = ({ children }: { children?: ReactNode }) => <>{children}</>;
  return {
    DropdownMenu: Pass,
    DropdownMenuTrigger: Pass,
    DropdownMenuContent: ({ children }: { children: ReactNode }) => <div role="menu">{children}</div>,
    DropdownMenuItem: ({ children, onSelect }: { children: ReactNode; onSelect?: () => void }) => (
      <button type="button" role="menuitem" onClick={onSelect}>
        {children}
      </button>
    ),
    DropdownMenuLabel: Pass,
    DropdownMenuSeparator: () => null,
    DropdownMenuRadioGroup: Pass,
    DropdownMenuRadioItem: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  };
});
vi.mock('@/components/ui/confirm-dialog', () => ({
  ConfirmDialog: (p: {
    open: boolean;
    title: string;
    description?: string;
    confirmText?: string;
    cancelText?: string;
    onConfirm?: () => void;
    onOpenChange: (open: boolean) => void;
  }) =>
    p.open ? (
      <div role="dialog" aria-label={p.title}>
        <p>{p.description}</p>
        <button type="button" onClick={() => p.onConfirm?.()}>
          {p.confirmText}
        </button>
        <button type="button" onClick={() => p.onOpenChange(false)}>
          {p.cancelText}
        </button>
      </div>
    ) : null,
}));

function todo(patch: Partial<TeammateTodo> = {}): TeammateTodo {
  return {
    id: 'todo-1',
    revision: 3,
    key: 'user:1',
    origin: 'assigned',
    title: '回复 Dash 的部署窗口问题',
    progress: '',
    outcome: '',
    value: '',
    next: null,
    sources: [{ kind: 'feishu', id: 'm1', label: '飞书' }] as TeammateTodo['sources'],
    associations: [],
    status: 'open',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    sourceDeadline: null,
    deadlineCandidate: null,
    suggestedDate: null,
    decision: null,
    history: [],
    action: null,
    ...patch,
  };
}

let transport: TodoTransport & { update: ReturnType<typeof vi.fn> };
beforeEach(() => {
  transport = {
    list: vi.fn(async () => ({ items: [todo()] })),
    update: vi.fn(async () => todo()),
    act: vi.fn(async () => null),
  };
});
afterEach(cleanup);

async function openRow() {
  render(<TodoPanel transport={transport} />);
  return within(await screen.findByRole('listitem'));
}

it('shows one title line and a due · origin · source meta line, without an empty date button', async () => {
  const row = await openRow();
  expect(row.getByText('回复 Dash 的部署窗口问题')).toBeTruthy();
  expect(row.getByText('teammateTodo.assigned · 飞书')).toBeTruthy();
  expect(row.queryByRole('button', { name: 'teammateTodo.deadline' })).toBeNull();
});

it.each([
  ['delete', 'teammateTodo.deleteConfirmTitle'],
  ['mute', 'teammateTodo.muteConfirmTitle'],
] as const)('asks before %s and only writes after confirming', async (operation, title) => {
  const row = await openRow();
  fireEvent.click(row.getByRole('menuitem', { name: `teammateTodo.${operation}` }));
  const dialog = await screen.findByRole('dialog', { name: title });
  expect(transport.update).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole('button', { name: `teammateTodo.${operation}` }));
  await waitFor(() =>
    expect(transport.update).toHaveBeenCalledWith({ operation, id: 'todo-1', expectedRevision: 3 }),
  );
  await waitFor(() => expect(screen.queryByRole('dialog', { name: title })).toBeNull());
});

it.each(['delete', 'mute'] as const)('cancelling %s writes nothing', async (operation) => {
  const row = await openRow();
  fireEvent.click(row.getByRole('menuitem', { name: `teammateTodo.${operation}` }));
  const dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'teammateTodo.cancel' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(transport.update).not.toHaveBeenCalled();
});

it('puts the next action first in the row menu instead of a separate pill', async () => {
  transport.list = vi.fn(async () => ({
    items: [todo({ next: { kind: 'advance', label: '让伙伴接着做', instruction: '回复' } as TeammateTodo['next'] })],
  }));
  const row = await openRow();
  const items = row.getAllByRole('menuitem');
  expect(items[0]!.textContent).toBe('让伙伴接着做');
  fireEvent.click(items[0]!);
  await waitFor(() => expect(transport.act).toHaveBeenCalledWith(expect.objectContaining({ id: 'todo-1', revision: 3 })));
});
