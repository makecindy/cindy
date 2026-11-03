// @vitest-environment jsdom
import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { toast, getToastSnapshot } from '@/lib/toast';
import { ToastContainer } from '@/components/ui/toast/ToastContainer';

// Issue 8237, unit/jsdom: repository discovery must not authorize an import. Loader
// tests cannot detect a UI that submits on cancel, uses a newer unreviewed hash,
// or loses the review action after StrictMode's effect replay.
// PR 8246: use real Toast dismissal; cancellation must retain an action without
// another discovery event. Three imports must leave room for unrelated alerts.
const state = vi.hoisted(() => ({
  t: (key: string, values?: Record<string, unknown>) => `${key} ${JSON.stringify(values ?? {})}` }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: state.t }) }));

import { ConfirmDialogProvider } from '@/components/ui/confirm-dialog-provider';
import { ProjectAutomationNotifyBridge } from '../ProjectAutomationNotifyBridge';

afterEach(async () => { cleanup(); toast.dismissAll(); await vi.advanceTimersByTimeAsync(400);
  vi.useRealTimers(); vi.clearAllMocks(); window.history.replaceState({}, '', '/'); });

it('requires a visible confirmation and reopens review for changed imports', async () => {
  vi.useFakeTimers();
  const pending: ProjectAutomationImport = { workingDir: '/project', configHash: 'reviewed',
    schedules: [{ name: 'Daily', prompt: 'Check releases', preRunHook: { command: 'node check.mjs' } }],
    removedNames: ['Old automation'] };
  const updated = { ...pending, configHash: 'changed' };
  const reconcile = vi.fn().mockRejectedValueOnce(new Error('Import failed'))
    .mockResolvedValueOnce({ pendingImport: updated }).mockResolvedValue({});
  let listener: (event: ProjectAutomationEvent) => void = () => {};
  const unsubscribe = vi.fn();
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { maker: { projectAutomation: {
    listPendingImports: vi.fn().mockResolvedValue([pending]), reconcile,
    onEvent: (cb: typeof listener) => { listener = cb; return unsubscribe; },
  } } } });
  const view = render(<StrictMode><ConfirmDialogProvider><ProjectAutomationNotifyBridge /><ToastContainer /></ConfirmDialogProvider></StrictMode>);
  await act(async () => {});
  expect(getToastSnapshot()).toHaveLength(1);
  const review = () => {
    fireEvent.click(screen.getByRole('button', { name: /import.review/ }));
  };
  review();
  expect(screen.getByText(/node check.mjs/)).toBeTruthy();
  expect(screen.getByText(/Old automation/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /confirmDialog.cancel/ }));
  await act(async () => { await vi.advanceTimersByTimeAsync(400); });
  expect(reconcile).not.toHaveBeenCalled();
  review();
  fireEvent.click(screen.getByRole('button', { name: /import.accept/ }));
  await act(async () => { await vi.advanceTimersByTimeAsync(400); });
  expect(screen.getByText('Import failed')).toBeTruthy();
  review();
  fireEvent.click(screen.getByRole('button', { name: /import.accept/ }));
  await act(async () => { await vi.advanceTimersByTimeAsync(400); });
  expect(reconcile).toHaveBeenCalledWith({ workingDir: '/project', approvedHash: 'reviewed' });
  expect(reconcile).toHaveBeenCalledTimes(2);
  review();
  fireEvent.click(screen.getByRole('button', { name: /import.accept/ }));
  await act(async () => { await vi.advanceTimersByTimeAsync(400); });
  expect(reconcile).toHaveBeenLastCalledWith({ workingDir: '/project', approvedHash: 'changed' });
  expect(screen.queryByRole('button', { name: /import.review/ })).toBeNull();
  act(() => {
    for (const workingDir of ['/one', '/two', '/three']) listener({ type: 'import-required', pendingImport: { ...pending, workingDir } });
    toast.success('Saved');
  });
  expect(screen.getAllByRole('button', { name: /import.review/ })).toHaveLength(1);
  expect(screen.getByText('Saved')).toBeTruthy();
  review();
  fireEvent.click(screen.getByRole('button', { name: /confirmDialog.cancel/ }));
  await act(async () => { await vi.advanceTimersByTimeAsync(400); });
  expect(screen.getByText(/import.found.*two/)).toBeTruthy();
  view.unmount();
  expect(unsubscribe).toHaveBeenCalled();
});

it.each(['secondaryWindow', 'sidebarWindow'])('does not offer imports in %s', async (kind) => {
  vi.useFakeTimers();
  window.history.replaceState({}, '', `/?${kind}=1`);
  const listPendingImports = vi.fn().mockResolvedValue([]);
  const onEvent = vi.fn(() => vi.fn());
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { maker: { projectAutomation: {
    listPendingImports, onEvent,
  } } } });
  render(<ConfirmDialogProvider><ProjectAutomationNotifyBridge /></ConfirmDialogProvider>);
  await act(async () => {});
  expect(listPendingImports).not.toHaveBeenCalled();
  expect(onEvent).not.toHaveBeenCalled();
});
