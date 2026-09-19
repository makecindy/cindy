// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WorktreeRecycleCard } from '../WorktreeRecycleCard';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn() } }));
afterEach(cleanup);
it('shows the failure and sends a generation-bound retry, then refreshes', async () => {
  const row = { id: 'resource', generation: 'g1', name: 'fixture', path: '/fixture', state: 'paused', reason: 'integrity', failures: 3 };
  const list = vi.fn().mockResolvedValue([row]);
  const control = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(window, 'electronAPI', { value: { worktreeRecycle: { list, control } }, configurable: true });
  render(<WorktreeRecycleCard />);
  await screen.findByText('settings.worktreeRecycle.reason.integrity', { exact: false });
  fireEvent.click(screen.getByRole('button', { name: 'settings.worktreeRecycle.retry' }));
  await waitFor(() => expect(control).toHaveBeenCalledWith({ id: 'resource', generation: 'g1', action: 'retry' }));
  await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
});
describe('retained directories', () => {
  it('keeps retry available but disables repeated keep', async () => {
    Object.defineProperty(window, 'electronAPI', { value: { worktreeRecycle: {
      list: vi.fn().mockResolvedValue([{ id: 'resource', generation: 'g1', name: 'fixture', path: '/fixture', state: 'kept', reason: 'kept', failures: 0 }]),
      control: vi.fn(),
    } }, configurable: true });
    render(<WorktreeRecycleCard />);
    await screen.findByText('fixture');
    expect((screen.getByRole('button', { name: 'settings.worktreeRecycle.keep' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'settings.worktreeRecycle.retry' }) as HTMLButtonElement).disabled).toBe(false);
  });
});
