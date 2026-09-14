// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { InstallTargetPicker } from '../InstallTargetPicker';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../hooks/useProjectsForPicker', () => ({ useProjectsForPicker: () => ({ projects: [], loading: false }) }));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({ useConfirmDialog: () => ({ confirm: vi.fn() }) }));
afterEach(cleanup);

function Harness({ runAction = vi.fn() }: { runAction?: () => Promise<{ success: false }> }) {
  const [open, setOpen] = useState(false);
  return <>
    <button onClick={() => setOpen(true)}>Open picker</button>
    <button>Background action</button>
    <InstallTargetPicker open={open} skill={{ name: 'demo' }} onClose={() => setOpen(false)} onInstallComplete={vi.fn()} runAction={runAction} />
  </>;
}

it('focuses Cancel, contains Tab, closes on Escape and restores the opener', async () => {
  window.electronAPI = { skillhub: { registry: { getByName: vi.fn().mockResolvedValue({ success: false }) } } } as never;
  render(<Harness />);
  const opener = screen.getByRole('button', { name: 'Open picker' });
  await userEvent.click(opener);
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'skillhub.detail.cancel' })));
  for (let i = 0; i < 7; i++) {
    await userEvent.tab();
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);
  }
  await userEvent.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(document.activeElement).toBe(opener);
});

it('does not dismiss or repeat installation while the selected operation is pending', async () => {
  window.electronAPI = { skillhub: { registry: { getByName: vi.fn().mockResolvedValue({ success: false }) } } } as never;
  const run = vi.fn(() => new Promise<{ success: false }>(() => {}));
  render(<Harness runAction={run} />);
  await userEvent.click(screen.getByText('Open picker'));
  const action = screen.getByRole('button', { name: /skillhub.installPicker.global/ });
  fireEvent.click(action);fireEvent.click(action);
  await userEvent.keyboard('{Escape}');
  expect(run).toHaveBeenCalledOnce();
  expect(screen.getByRole('dialog')).not.toBeNull();
  expect((screen.getByRole('button', { name: 'skillhub.detail.cancel' }) as HTMLButtonElement).disabled).toBe(true);
});
