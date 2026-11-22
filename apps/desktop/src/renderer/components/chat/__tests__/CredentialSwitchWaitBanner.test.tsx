// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { CredentialSwitchWaitBanner } from '../CredentialSwitchWaitBanner';

const getSession = vi.hoisted(() => vi.fn(async (id: string) => ({ title: id === 'other' ? 'Other task' : 'Current task' })));
vi.mock('@/lib/sessionService', () => ({ get: getSession }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: { titles?: string }) => values?.titles ?? key,
    i18n: { language: 'en' },
  }),
}));
afterEach(() => {
  cleanup();
  getSession.mockClear();
});

// L342 N2, renderer unit. A same-task wait has the existing pending-picker display.
// The cross-task banner is a different entry, with its own title lookup and cancel control.
it('does not render the cross-task banner or fetch a title for the task settling its own choice', () => {
  const session = { sessionId: 'self', blockedBySessionIds: ['self'] };
  const { container } = render(<CredentialSwitchWaitBanner {...session} onCancel={vi.fn()} />);
  expect(container.childElementCount).toBe(0);
  expect(getSession).not.toHaveBeenCalled();
});

it('shows the other blocked task and its cancel action even when the current task is included', async () => {
  const session = { sessionId: 'self', blockedBySessionIds: ['self', 'other'] };
  const cancel = vi.fn();
  render(<CredentialSwitchWaitBanner {...session} onCancel={cancel} />);
  expect(await screen.findByText('Other task')).toBeTruthy();
  expect(getSession.mock.calls).toEqual([['other']]);
  fireEvent.click(screen.getByRole('button'));
  expect(cancel).toHaveBeenCalledOnce();
});

it('keeps the generic cross-task notice for older projections without blocker ids', () => {
  const session = { sessionId: 'self', blockedBySessionIds: [] };
  render(<CredentialSwitchWaitBanner {...session} />);
  expect(screen.getByText('chat.credentialSwitchWait.waiting')).toBeTruthy();
});
