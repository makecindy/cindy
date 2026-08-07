// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { getSplitPanes, splitGroupStore } from '../../splitGroupStore';
import { OpenInSplitMenu } from '../OpenInSplitMenu';

const { toastWarningMock } = vi.hoisted(() => ({
  toastWarningMock: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@/lib/toast', () => ({
  toast: { warning: toastWarningMock },
}));

function renderMenu(
  sessionId: string,
  onOpenSession = vi.fn(),
  options: { initialEntry?: string; orcaRole?: string } = {},
) {
  render(
    <MemoryRouter initialEntries={[options.initialEntry ?? '/cc-agent/session-a']}>
      <DropdownMenu defaultOpen modal={false}>
        <DropdownMenuTrigger>More</DropdownMenuTrigger>
        <DropdownMenuContent>
          <OpenInSplitMenu
            sessionId={sessionId}
            orcaRole={options.orcaRole}
            onOpenSession={onOpenSession}
          />
        </DropdownMenuContent>
      </DropdownMenu>
    </MemoryRouter>,
  );
  return onOpenSession;
}

describe('OpenInSplitMenu', () => {
  beforeEach(() => {
    localStorage.clear();
    toastWarningMock.mockClear();
    splitGroupStore.__resetForTest();
  });

  afterEach(() => {
    cleanup();
    splitGroupStore.__resetForTest();
  });

  it('opens all four split actions from the keyboard and applies the selected direction', async () => {
    const onOpenSession = renderMenu('session-b');
    const submenuTrigger = await screen.findByRole('menuitem', {
      name: 'splitGroup.openInSplit',
    });

    await act(async () => {
      submenuTrigger.focus();
      fireEvent.keyDown(submenuTrigger, { key: 'ArrowRight' });
      await Promise.resolve();
    });

    for (const side of ['left', 'right', 'top', 'bottom']) {
      expect(
        await screen.findByRole('menuitem', { name: `splitGroup.openSide.${side}` }),
      ).toBeTruthy();
    }
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'splitGroup.openSide.right' }));
      await Promise.resolve();
    });

    expect(onOpenSession).toHaveBeenCalledTimes(1);
    expect(getSplitPanes(splitGroupStore.getSnapshot().root).map((pane) => pane.sessionId)).toEqual(
      ['session-a', 'session-b'],
    );
    expect(splitGroupStore.getSnapshot().root).toMatchObject({ type: 'split', direction: 'row' });
  });

  it('keeps an unavailable entry as a valid focusable menu item with an actionable reason', async () => {
    act(() => {
      splitGroupStore.addSession('session-b', 'session-a', 'right');
    });
    renderMenu('session-b');
    const submenuTrigger = await screen.findByRole('menuitem', {
      name: 'splitGroup.openInSplit',
      description: 'splitGroup.alreadyOpen',
    });

    expect(submenuTrigger.getAttribute('aria-disabled')).toBe('true');
    expect(submenuTrigger.hasAttribute('data-disabled')).toBe(false);
    act(() => submenuTrigger.focus());
    expect(document.activeElement).toBe(submenuTrigger);
    expect(submenuTrigger.textContent).toContain('splitGroup.alreadyOpen');
  });

  it('explains that Worker sessions must be opened through their Lead', async () => {
    renderMenu('worker-b', vi.fn(), { orcaRole: 'worker' });

    expect(
      await screen.findByRole('menuitem', {
        name: 'splitGroup.openInSplit',
        description: 'splitGroup.workerUnavailable',
      }),
    ).toBeTruthy();
  });

  it('reports the pane limit separately from a missing route anchor', async () => {
    act(() => {
      splitGroupStore.addSession('session-b', 'session-a', 'right');
      for (let index = 3; index <= 8; index += 1) {
        splitGroupStore.addSession(`session-${index}`, 'session-b', 'bottom');
      }
    });
    const firstView = renderMenu('session-over-limit');
    expect(
      await screen.findByRole('menuitem', {
        name: 'splitGroup.openInSplit',
        description: 'splitGroup.limitReached',
      }),
    ).toBeTruthy();

    cleanup();
    splitGroupStore.__resetForTest();
    act(() => {
      splitGroupStore.addSession('session-b', 'session-a', 'right');
    });
    renderMenu('session-c', firstView, { initialEntry: '/cc-agent/session-missing' });

    expect(
      await screen.findByRole('menuitem', {
        name: 'splitGroup.openInSplit',
        description: 'splitGroup.addUnavailable',
      }),
    ).toBeTruthy();
  });

  it('uses the generic unavailable reason for a normal session without a route anchor', async () => {
    renderMenu('session-b', vi.fn(), { initialEntry: '/cc-agent' });

    expect(
      await screen.findByRole('menuitem', {
        name: 'splitGroup.openInSplit',
        description: 'splitGroup.addUnavailable',
      }),
    ).toBeTruthy();
    expect(screen.queryByText('splitGroup.workerUnavailable')).toBeNull();
  });
});
