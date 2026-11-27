// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WorktreeRecycleCard } from '../WorktreeRecycleCard';
import { toast } from '@/lib/toast';
import { formatPrecreatedWorktreePreservedMessage } from '../../../../shared/remotePrecreatedWorktreeLedger';
import type { PendingRemotePrecreatedWorktree } from '../../../../shared/remotePrecreatedWorktreeLedger';

const confirmMock = vi.hoisted(() => vi.fn<() => Promise<boolean>>());
const useOptionalConfirmDialogMock = vi.hoisted(() =>
  vi.fn<() => { confirm: typeof confirmMock } | null>(() => null),
);

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useOptionalConfirmDialog: () => useOptionalConfirmDialogMock(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  useOptionalConfirmDialogMock.mockReturnValue(null);
});
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

/*
 * Test value (engineering-conventions §3.2)
 * - Production entry: WorktreeRecycleCard remote pending worktree management in Settings → Storage.
 * - Bug/rule basis: when remote precreated worktree cleanup was deterministically refused, users had no UI
 *   visibility into remote-precreated-worktree-ledger records and no way to retry or unblock without editing files.
 * - Existing coverage gap: WorktreeRecycleCard tests previously covered only local worktreeRecycle rows.
 * - Minimal failing inputs: a pending remote ledger record failing with dirty refusal on retry, followed by
 *   confirmed keep-and-unblock calling remotePrecreatedWorktreeLedger.forget.
 */
describe('remote pending worktrees', () => {
  it('displays remote pending records, reports specific retry failure reasons, and unblocks after confirmation', async () => {
    let records: PendingRemotePrecreatedWorktree[] = [{
      dataOwnerId: 'owner-1',
      deviceId: 'dev-mbp-16',
      sessionId: 'abcdef1234567890',
      recoveryKey: 'recovery-key-123456',
      createdAt: Date.now(),
      phase: 'reserved',
      lastFailureKind: 'preserved',
      lastFailureReason: 'dirty',
      lastFailureAt: Date.now(),
    }];
    const ledgerList = vi.fn(async () => ({ records: [...records], storageReadable: true }));
    const ledgerRegister = vi.fn(async (record: PendingRemotePrecreatedWorktree) => {
      records = [record];
      return { persisted: true };
    });
    const ledgerForget = vi.fn(async () => {
      records = [];
      return { persisted: true };
    });
    const invoke = vi.fn(async (_deviceId: string, channel: string) => {
      if (channel === 'local-db:sessions:get') throw new Error('[NOT_FOUND] Session 不存在');
      if (channel === 'worktree:discard-precreated') {
        throw new Error(`[PRECONDITION_FAILED] ${formatPrecreatedWorktreePreservedMessage('dirty')}`);
      }
      throw new Error(`unexpected ${channel}`);
    });
    confirmMock.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    useOptionalConfirmDialogMock.mockReturnValue({ confirm: confirmMock });

    Object.defineProperty(window, 'electronAPI', {
      value: {
        worktreeRecycle: { list: vi.fn().mockResolvedValue([]), control: vi.fn() },
        remotePrecreatedWorktreeLedger: { list: ledgerList, register: ledgerRegister, forget: ledgerForget },
        deviceLink: {
          listDevices: vi.fn().mockResolvedValue({ devices: [{ deviceId: 'dev-mbp-16', name: 'MacBook Pro 16' }] }),
          invoke,
        },
      },
      configurable: true,
    });

    render(<WorktreeRecycleCard />);
    await screen.findByText('MacBook Pro 16');
    expect(screen.getByText('settings.worktreeRecycle.remote.preserveReason.dirty', { exact: false })).toBeTruthy();
    expect(screen.queryByText('settings.worktreeRecycle.empty')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'settings.worktreeRecycle.retry' }));
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('ccAgent.draft.remoteWorktreeCleanup.preservedDirty');
    });

    fireEvent.click(screen.getByRole('button', { name: 'settings.worktreeRecycle.remote.keepUnblock' }));
    await waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(1));
    expect(ledgerForget).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'settings.worktreeRecycle.remote.keepUnblock' }));
    await waitFor(() => expect(ledgerForget).toHaveBeenCalledTimes(1));
    await screen.findByText('settings.worktreeRecycle.empty');
    expect(toast.success).toHaveBeenCalledWith('settings.worktreeRecycle.remote.keepSuccess');
  });
});
