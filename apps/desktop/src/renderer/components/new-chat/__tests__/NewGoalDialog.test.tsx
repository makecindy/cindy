// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { createIpcError } from '../../../../shared/ipc-errors';
import { NewGoalDialog } from '../NewGoalDialog';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/makerTransport', () => ({ goalApiFor: vi.fn() }));
afterEach(cleanup);

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
