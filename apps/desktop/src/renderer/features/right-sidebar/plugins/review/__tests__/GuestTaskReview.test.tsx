// @vitest-environment jsdom
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { sharedTaskHostPeer } from '@cindy/device-link';
import GuestTaskReview from '../GuestTaskReview';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

// A terminal edit in a sibling folder has no chat record. Refresh after the owner
// restores the file must remove it from the guest's current differences.
it('reads the host worktree and drops reverted changes on refresh', async () => {
  const peer = sharedTaskHostPeer('share', 'device');
  const file = { id: 'unstaged:other/notes.txt', path: 'other/notes.txt', hunks: [] };
  const reply = (unstaged: typeof file[]) => ({ ok: true, result: {
    scope: { disabledReason: null }, summary: { dirty: unstaged.length > 0 }, diffs: { staged: [], unstaged },
  } });
  const invoke = vi.fn().mockResolvedValueOnce(reply([file])).mockResolvedValueOnce(reply([]));
  vi.stubGlobal('electronAPI', { deviceLink: { invoke } });
  render(<GuestTaskReview peer={peer} sessionId="task" />);
  expect(await screen.findByText('other/notes.txt')).toBeTruthy();
  expect(invoke).toHaveBeenCalledExactlyOnceWith(peer, 'git-review:remote-op', [{ op: 'get', payload: { sessionId: 'task' } }]);
  fireEvent.click(screen.getByRole('button', { name: 'rightSidebar.review.refresh' }));
  expect(await screen.findByText('rightSidebar.review.emptyDescGit')).toBeTruthy();
  expect(screen.queryByText('other/notes.txt')).toBeNull();
});
