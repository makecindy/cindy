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

it('keeps ordinary remote exits unchanged and returns to tasks after a shared-task exit', () => {
  const onReturnToTasks = vi.fn();
  render(<SharedTaskEndedNotice onReturnToTasks={onReturnToTasks} />);
  act(() => { expect(notifySharedTaskEnded('ordinary-device')).toBe(false); });
  expect(screen.queryByRole('dialog')).toBeNull();
  act(() => { expect(notifySharedTaskEnded(sharedTaskHostPeer('share-1', 'desktop'))).toBe(true); });
  expect(screen.getByRole('dialog').textContent).toContain('sharedTask.accessEndedBody');
  fireEvent.click(screen.getByRole('button', { name: 'sharedTask.returnToTasks' }));
  expect(onReturnToTasks).toHaveBeenCalledOnce();
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('does not keep an ending notice visible across an account boundary', () => {
  const onReturnToTasks = vi.fn();
  const view = render(<SharedTaskEndedNotice onReturnToTasks={onReturnToTasks} />);
  act(() => { notifySharedTaskEnded(sharedTaskHostPeer('share-1', 'desktop')); });
  expect(screen.getByRole('dialog')).toBeTruthy();
  setDataOwnerGeneration('other');
  view.rerender(<SharedTaskEndedNotice onReturnToTasks={onReturnToTasks} />);
  expect(screen.queryByRole('dialog')).toBeNull();
});
