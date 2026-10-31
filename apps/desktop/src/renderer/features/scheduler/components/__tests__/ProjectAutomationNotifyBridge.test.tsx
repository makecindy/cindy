// @vitest-environment jsdom
import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { ToastOptions } from '@/lib/toast';

// Issue 8237, unit/jsdom: repository discovery must not authorize an import. Loader
// tests cannot detect a UI that submits on cancel, uses a newer unreviewed hash,
// or loses the review action after StrictMode's effect replay.
const state = vi.hoisted(() => ({ info: vi.fn(), dismiss: vi.fn(), error: vi.fn(),
  t: (key: string, values?: Record<string, unknown>) => `${key} ${JSON.stringify(values ?? {})}` }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: state.t }) }));
vi.mock('@/lib/toast', () => ({ toast: { info: state.info, dismiss: state.dismiss,
  error: state.error, success: vi.fn() } }));

import { ConfirmDialogProvider } from '@/components/ui/confirm-dialog-provider';
import { ProjectAutomationNotifyBridge } from '../ProjectAutomationNotifyBridge';

afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks(); });

it('requires a visible confirmation and reopens review for changed imports', async () => {
  vi.useFakeTimers();
  const pending: ProjectAutomationImport = { workingDir: '/project', configHash: 'reviewed',
    schedules: [{ name: 'Daily', prompt: 'Check releases', preRunHook: { command: 'node check.mjs' } }],
    removedNames: ['Old automation'] };
  const updated = { ...pending, configHash: 'changed' };
  const reconcile = vi.fn().mockResolvedValueOnce({ pendingImport: updated }).mockResolvedValue({});
  let listener: (event: ProjectAutomationEvent) => void = () => {};
  const unsubscribe = vi.fn();
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { maker: { projectAutomation: {
    listPendingImports: vi.fn().mockResolvedValue([pending]), reconcile,
    onEvent: (cb: typeof listener) => { listener = cb; return unsubscribe; },
  } } } });
  state.info.mockImplementation(() => `toast-${state.info.mock.calls.length}`);
  const view = render(<StrictMode><ConfirmDialogProvider><ProjectAutomationNotifyBridge /></ConfirmDialogProvider></StrictMode>);
  await act(async () => {});
  expect(state.info).toHaveBeenCalledTimes(1);
  const review = () => {
    const options = state.info.mock.lastCall![1] as ToastOptions;
    act(() => options.action!.onClick());
  };
  review();
  expect(screen.getByText(/node check.mjs/)).toBeTruthy();
  expect(screen.getByText(/Old automation/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /confirmDialog.cancel/ }));
  await act(async () => { await vi.advanceTimersByTimeAsync(200); });
  expect(reconcile).not.toHaveBeenCalled();
  act(() => listener({ type: 'import-required', pendingImport: pending }));
  review();
  fireEvent.click(screen.getByRole('button', { name: /import.accept/ }));
  await act(async () => { await vi.advanceTimersByTimeAsync(200); });
  expect(reconcile).toHaveBeenCalledWith({ workingDir: '/project', approvedHash: 'reviewed' });
  expect(state.info).toHaveBeenCalledTimes(3);
  expect(reconcile).toHaveBeenCalledTimes(1);
  review();
  fireEvent.click(screen.getByRole('button', { name: /import.accept/ }));
  await act(async () => {});
  expect(reconcile).toHaveBeenLastCalledWith({ workingDir: '/project', approvedHash: 'changed' });
  view.unmount();
  expect(unsubscribe).toHaveBeenCalled();
  expect(state.dismiss).toHaveBeenCalled();
});
