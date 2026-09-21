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

function Harness({
  runAction = vi.fn(),
  onInstallComplete = vi.fn(),
}: {
  runAction?: () => Promise<{ success: false }>;
  onInstallComplete?: () => void;
}) {
  const [open, setOpen] = useState(false);
  return <>
    <button onClick={() => setOpen(true)}>Open picker</button>
    <button>Background action</button>
    <InstallTargetPicker open={open} skill={{ name: 'demo' }} onClose={() => setOpen(false)} onInstallComplete={onInstallComplete} runAction={runAction} />
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

it('consumes Escape so an underlying window-level handler cannot close the host surface', async () => {
  window.electronAPI = { skillhub: { registry: { getByName: vi.fn().mockResolvedValue({ success: false }) } } } as never;
  // SkillhubMarketDetailView keeps a window-level Escape listener mounted
  // while the picker is stacked on top; the picker must consume the key
  // itself instead of letting it reach the host surface.
  const underlying = vi.fn();
  window.addEventListener('keydown', underlying);
  try {
    render(<Harness />);
    await userEvent.click(screen.getByText('Open picker'));
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(underlying).not.toHaveBeenCalled();
  } finally {
    window.removeEventListener('keydown', underlying);
  }
});

it('keeps consuming Escape while installing, so the underlying close lock cannot be bypassed', async () => {
  window.electronAPI = { skillhub: { registry: { getByName: vi.fn().mockResolvedValue({ success: false }) } } } as never;
  const underlying = vi.fn();
  window.addEventListener('keydown', underlying);
  const run = vi.fn(() => new Promise<{ success: false }>(() => {}));
  try {
    render(<Harness runAction={run} />);
    await userEvent.click(screen.getByText('Open picker'));
    fireEvent.click(screen.getByRole('button', { name: /skillhub.installPicker.global/ }));
    await userEvent.keyboard('{Escape}');
    expect(screen.getByRole('dialog')).not.toBeNull();
    expect(underlying).not.toHaveBeenCalled();
  } finally {
    window.removeEventListener('keydown', underlying);
  }
});

it('holds the busy lock across the other-directory flow, from selection to install completion', async () => {
  let resolvePick: (value: { success: boolean; path?: string }) => void = () => {};
  const showOpenDirectory = vi.fn(
    () => new Promise<{ success: boolean; path?: string }>((resolve) => { resolvePick = resolve; }),
  );
  window.electronAPI = {
    skillhub: { registry: { getByName: vi.fn().mockResolvedValue({ success: false }) } },
    dialog: { showOpenDirectory },
  } as never;
  const onInstallComplete = vi.fn();
  const run = vi.fn().mockResolvedValue({ success: true, absolutePath: '/tmp/skills/.agents/skills/demo' });
  render(<Harness runAction={run} onInstallComplete={onInstallComplete} />);
  await userEvent.click(screen.getByText('Open picker'));
  const other = screen.getByRole('button', { name: 'skillhub.installPicker.otherDirectory' });
  // Rapid double click: the lock is taken before the native dialog opens, so
  // only one selection request can ever start.
  fireEvent.click(other);fireEvent.click(other);
  expect(showOpenDirectory).toHaveBeenCalledOnce();
  expect((screen.getByRole('button', { name: 'skillhub.detail.cancel' }) as HTMLButtonElement).disabled).toBe(true);
  // Cancelling the native dialog releases the lock; the picker stays open.
  resolvePick({ success: false });
  await waitFor(() => expect((screen.getByRole('button', { name: 'skillhub.detail.cancel' }) as HTMLButtonElement).disabled).toBe(false));
  expect(screen.getByRole('dialog')).not.toBeNull();
  // A second round picks a directory and installs exactly once.
  fireEvent.click(other);
  resolvePick({ success: true, path: '/tmp/skills' });
  await waitFor(() => expect(onInstallComplete).toHaveBeenCalledOnce());
  expect(run).toHaveBeenCalledOnce();
  expect(run).toHaveBeenCalledWith({ name: 'demo', installPath: '/tmp/skills/.agents/skills/demo', catalogScope: undefined });
});
