// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { TeammateTodo } from '@cindy/maker-shared/teammate-todo';
import { TodoPanel, type TodoTransport } from '../BotTodoList';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key.replace('teammateTodo.', ''),
    i18n: { language: 'en' },
  }),
}));

beforeAll(() => {
  // jsdom lacks the pointer and scrolling APIs used by the real Radix menu.
  window.HTMLElement.prototype.hasPointerCapture ??= () => false;
  window.HTMLElement.prototype.setPointerCapture ??= () => {};
  window.HTMLElement.prototype.releasePointerCapture ??= () => {};
  window.HTMLElement.prototype.scrollIntoView ??= () => {};
});
afterEach(cleanup);

function todo(id: string, patch: Partial<TeammateTodo> = {}): TeammateTodo {
  return {
    id,
    revision: 1,
    key: id,
    origin: 'assigned',
    title: id,
    progress: '',
    outcome: '',
    value: '',
    next: null,
    sources: [],
    associations: [],
    status: 'open',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    sourceDeadline: null,
    deadlineCandidate: null,
    suggestedDate: null,
    decision: null,
    history: [],
    action: null,
    ...patch,
  };
}

async function mount(items: TeammateTodo[]) {
  const transport: TodoTransport = {
    list: vi.fn(async () => ({ items })),
    update: vi.fn(),
    act: vi.fn(),
  };
  const view = render(<TodoPanel transport={transport} />);
  await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  return { ...view, transport };
}

/** Picks one option in the header's filter menu (status, origin and order share it). */
async function choose(option: string) {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'filter' }));
  await user.click(await screen.findByRole('menuitemradio', { name: option }));
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
}

const openDone = () => fireEvent.click(screen.getByRole('button', { name: /^done/ }));

describe('TodoPanel filters', () => {
  it('switches between open and hidden todos without mutating the transport', async () => {
    const { transport } = await mount([
      todo('active'),
      todo('ignored', { decision: { kind: 'muted' } }),
    ]);
    expect(screen.queryByRole('button', { name: 'ignored' })).toBeNull();
    await choose('hidden');
    expect(screen.getByRole('button', { name: 'ignored' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'active' })).toBeNull();
    await choose('open');
    expect(screen.getByRole('button', { name: 'active' })).toBeTruthy();
    expect(transport.update).not.toHaveBeenCalled();
    expect(transport.act).not.toHaveBeenCalled();
  });

  it('combines origin selection with search for open and completed todos', async () => {
    await mount([
      todo('assigned match'),
      todo('discovered match', { origin: 'discovered' }),
      todo('assigned done match', { status: 'done' }),
      todo('discovered done match', { status: 'done', origin: 'discovered' }),
      todo('discovered other', { origin: 'discovered' }),
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'search' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'search' }), {
      target: { value: 'match' },
    });
    openDone();
    await choose('discovered');
    expect(screen.getByRole('button', { name: 'discovered match' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'discovered done match' })).toBeTruthy();
    for (const name of ['assigned match', 'assigned done match', 'discovered other']) {
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
    await choose('assigned');
    expect(screen.getByRole('button', { name: 'assigned match' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'assigned done match' })).toBeTruthy();
  });

  it('reorders both open and completed lists using the existing comparators', async () => {
    const deadline = { kind: 'date', date: '2026-12-01', timeZone: 'UTC' } as const;
    const { container } = await mount([
      todo('older'),
      todo('due', { createdAt: '2026-02-01T00:00:00Z', sourceDeadline: deadline }),
      todo('older done', { status: 'done' }),
      todo('due done', {
        status: 'done',
        createdAt: '2026-02-01T00:00:00Z',
        sourceDeadline: deadline,
      }),
    ]);
    openDone();
    const ids = () =>
      Array.from(container.querySelectorAll('[data-todo-id]'), (row) =>
        row.getAttribute('data-todo-id'),
      );
    expect(ids()).toEqual(['due', 'older', 'due done', 'older done']);
    await choose('createdOrder');
    expect(ids()).toEqual(['older', 'due', 'older done', 'due done']);
    await choose('dueOrder');
    expect(ids()).toEqual(['due', 'older', 'due done', 'older done']);
  });

  it.each(['hidden', 'assigned', 'createdOrder'])('resets both pagination controls when choosing %s', async (option) => {
    await mount(
      Array.from({ length: 30 }, (_, index) => [
        todo(`assigned ${index}`),
        todo(`discovered ${index}`, { origin: 'discovered' }),
        todo(`hidden ${index}`, { decision: { kind: 'muted' } }),
        todo(`done ${index}`, { status: 'done' }),
      ]).flat(),
    );
    openDone();
    for (const next of screen.getAllByRole('button', { name: 'following' })) fireEvent.click(next);
    expect(
      screen
        .getAllByRole<HTMLButtonElement>('button', { name: 'previous' })
        .every((button) => !button.disabled),
    ).toBe(true);
    await choose(option);
    expect(
      screen
        .getAllByRole<HTMLButtonElement>('button', { name: 'previous' })
        .every((button) => button.disabled),
    ).toBe(true);
  });
});
