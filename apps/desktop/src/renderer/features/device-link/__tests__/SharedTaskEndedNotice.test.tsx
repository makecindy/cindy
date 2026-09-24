// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { sharedTaskHostPeer } from '@cindy/device-link';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { SharedTaskEndedNotice, notifySharedTaskEnded } from '../SharedTaskEndedNotice';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ dataOwnerId: 'owner' }) }));
beforeEach(() => setDataOwnerGeneration('owner'));
afterEach(cleanup);

it('keeps ordinary remote exits unchanged and offers a new invitation after a shared-task exit', () => {
  const onJoin = vi.fn();
  render(<SharedTaskEndedNotice onJoin={onJoin} />);
  act(() => { expect(notifySharedTaskEnded('ordinary-device')).toBe(false); });
  expect(screen.queryByRole('dialog')).toBeNull();
  act(() => { expect(notifySharedTaskEnded(sharedTaskHostPeer('share-1', 'desktop'))).toBe(true); });
  expect(screen.getByRole('dialog').textContent).toContain('sharedTask.accessEndedBody');
  fireEvent.click(screen.getByRole('button', { name: 'sharedTask.rejoin' }));
  expect(onJoin).toHaveBeenCalledOnce();
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('does not keep an ending notice visible across an account boundary', () => {
  const onJoin = vi.fn();
  const view = render(<SharedTaskEndedNotice onJoin={onJoin} />);
  act(() => { notifySharedTaskEnded(sharedTaskHostPeer('share-1', 'desktop')); });
  expect(screen.getByRole('dialog')).toBeTruthy();
  setDataOwnerGeneration('other');
  view.rerender(<SharedTaskEndedNotice onJoin={onJoin} />);
  expect(screen.queryByRole('dialog')).toBeNull();
});
