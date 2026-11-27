// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { createIpcError } from '../../../../shared/ipc-errors';
import { NewGoalDialog } from '../NewGoalDialog';
import { WorktreeCreatingOverlay } from '../WorktreeCreatingOverlay';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/makerTransport', () => ({ goalApiFor: vi.fn(), readBackgroundTaskOutputTailFor: vi.fn() }));
afterEach(() => { cleanup(); vi.useRealTimers(); });

// #7395 review: exercise the real dialog after a handled picker failure.
// The existing route tests inject goal creation and cannot observe its error UI.
// Minimal input: picker error followed by an unrelated retry error; component/unit tier.
it('shows a new goal creation error even while directory recovery remains visible', async () => {
  const create = vi.fn()
    .mockRejectedValueOnce(createIpcError('WRITABLE_DIRECTORY_AUTHORIZATION_REQUIRED', 'Picker proof required'))
    .mockRejectedValueOnce(new Error('Collaboration policy is still loading'));
  render(<NewGoalDialog open onOpenChange={vi.fn()} onCreate={create}
    initialObjective="Keep the original goal" creationRecovery={<span>Folders reselected</span>} />);

  const start = await screen.findByRole('button', { name: 'goal.newGoalDialog.start' });
  await waitFor(() => expect(start.hasAttribute('disabled')).toBe(false));
  fireEvent.click(start);
  await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
  expect(screen.queryByText('Picker proof required')).toBeNull();

  await waitFor(() => expect(start.hasAttribute('disabled')).toBe(false));
  fireEvent.click(start);
  expect(await screen.findByText('Collaboration policy is still loading')).toBeTruthy();
  expect(screen.getByText('Folders reselected')).toBeTruthy();
  expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('Keep the original goal');
});

// #7395 macOS acceptance: Main rejects an expired grant, then the parent adds
// the recovery notice in the same failed submit. The existing case starts with
// that notice already present, so it misses this render timing. Component/unit.
it('does not expose a handled picker error when recovery appears during creation', async () => {
  function Harness() {
    const [recovering, setRecovering] = useState(false);
    return <NewGoalDialog open onOpenChange={vi.fn()} initialObjective="Original goal"
      onCreate={async () => {
        setRecovering(true);
        throw createIpcError('WRITABLE_DIRECTORY_AUTHORIZATION_REQUIRED', 'Raw picker error');
      }}
      creationRecovery={recovering
        ? <button type="button" onClick={() => setRecovering(false)}>Clear recovery</button>
        : undefined} />;
  }
  render(<Harness />);
  fireEvent.click(await screen.findByRole('button', { name: 'goal.newGoalDialog.start' }));
  expect(await screen.findByRole('button', { name: 'Clear recovery' })).toBeTruthy();
  await waitFor(() => expect(screen.queryByText(/Raw picker error/)).toBeNull());
  fireEvent.click(screen.getByRole('button', { name: 'Clear recovery' }));
  expect(screen.queryByText(/Raw picker error/)).toBeNull();
  expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('Original goal');
});

// PR #10836: a pending Goal keeps its modal open, so background progress is invisible.
// Exercise the real dialog + loading card; the existing error-only cases never wait for
// worktree creation. Minimal input is one unresolved onCreate Promise; component/unit.
it('shows worktree waiting inside the open goal dialog and clears it when creation settles', async () => {
  vi.useFakeTimers();
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  const close = vi.fn();
  function Harness() {
    const [startedAt, setStartedAt] = useState<number>();
    return <NewGoalDialog open onOpenChange={close} initialObjective="Create a goal"
      onCreate={async () => {
        setStartedAt(Date.now());
        try { await pending; } finally { setStartedAt(undefined); }
      }}
      creationProgress={startedAt === undefined ? undefined : (
        <WorktreeCreatingOverlay branchName="cindy/goal" startedAt={startedAt} />
      )} />;
  }
  render(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: 'goal.newGoalDialog.start' }));
  const dialog = within(screen.getByRole('alertdialog'));
  expect(dialog.getByRole('status')).toBeTruthy();
  expect(dialog.queryByText('newChat.worktreeCreatingOverlay.elapsed')).toBeNull();
  act(() => { vi.advanceTimersByTime(4_000); });
  expect(dialog.getByText('newChat.worktreeCreatingOverlay.elapsed')).toBeTruthy();
  expect(close).not.toHaveBeenCalled();
  await act(async () => { finish(); await pending; });
  expect(dialog.queryByRole('status')).toBeNull();
  expect(close).toHaveBeenCalledWith(false);
});
