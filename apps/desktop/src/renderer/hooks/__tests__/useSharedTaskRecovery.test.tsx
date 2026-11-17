// @vitest-environment jsdom
// Unit: terminal shared-task failures need an actionable, cancellable prompt.
// The prior banner only suggested retrying forever. Minimal input: one pinned
// allocation failure. Exercise the real hook, dialog and choice/cancellation UI.
import { StrictMode, useCallback, type ReactNode } from 'react';
import { act, cleanup, fireEvent, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { ConfirmDialogProvider } from '@/components/ui/confirm-dialog-provider';
import * as dialogProvider from '@/components/ui/confirm-dialog-provider';
import en from '@/i18n/locales/en/common.json';
import { useSharedTaskRecovery } from '../useSharedTaskRecovery';
import { sharedTaskRecoveryError } from '../../../shared/sharedTaskRecovery';
import { makerChatStore } from '@/lib/makerChatStore';

afterEach(cleanup);

let sequence = 0;
async function setup(active = true, sessionId = `history-${++sequence}`) {
  const i18n = createInstance();
  await i18n.init({ lng: 'en', resources: { en: { translation: en } }, interpolation: { escapeValue: false } });
  const wrapper = ({ children }: { children: ReactNode }) => <StrictMode><I18nextProvider i18n={i18n}>
    <ConfirmDialogProvider>{children}</ConfirmDialogProvider>
  </I18nextProvider></StrictMode>;
  const initialProps = { sessionId, agentDeviceId: 'share:one',
    error: sharedTaskRecoveryError('authorization', 'unknown').message, active, handledUsageLimit: false };
  const rendered = renderHook(useSharedTaskRecovery, { wrapper, initialProps });
  await act(async () => { await Promise.resolve(); });
  return { ...rendered, initialProps };
}

describe('shared task terminal recovery', () => {
  // Unit: a manual request belongs to one terminal episode, not the view
  // instance reused while navigating between already-acknowledged tasks.
  it('does not carry a completed manual prompt across tasks or back to its original task', async () => {
    // Observe requests as well as visibility: a queued dialog can still be
    // hidden by the preceding dialog's closing animation at this instant.
    const useDialog = dialogProvider.useConfirmDialog;
    let prompts = 0;
    const observe = vi.spyOn(dialogProvider, 'useConfirmDialog').mockImplementation(function useObservedDialog() {
      const api = useDialog();
      const confirm = useCallback((...args: Parameters<typeof api.confirm>) => {
        prompts++;
        return api.confirm(...args);
      }, [api.confirm]);
      return { ...api, confirm };
    });
    try {
      const h = await setup();
      const dismiss = async () => {
        await screen.findByText(en.sharedTaskRecovery.title);
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.sharedTaskRecovery.cancel })); });
      };
      await dismiss();
      const other = { ...h.initialProps, sessionId: `${h.initialProps.sessionId}-other` };
      h.rerender(other); await dismiss();
      await act(async () => { h.result.current.askAgain?.(); });
      await dismiss();
      const answered = prompts;
      expect(answered).toBe(3);
      h.rerender(h.initialProps);
      await act(async () => { await Promise.resolve(); });
      expect(prompts).toBe(answered);
      expect(screen.queryByText(en.sharedTaskRecovery.title)).toBeNull();
      h.rerender(other);
      await act(async () => { await Promise.resolve(); });
      expect(screen.queryByText(en.sharedTaskRecovery.title)).toBeNull();
      await act(async () => { h.result.current.askAgain?.(); });
      await screen.findByText(en.sharedTaskRecovery.title);
    } finally { cleanup(); observe.mockRestore(); }
  });
  // Unit: route navigation unmounts the view, not the terminal failure.
  it('remembers a declined prompt after the task view unmounts, while retaining the manual exit', async () => {
    const first = await setup();
    await screen.findByText(en.sharedTaskRecovery.title);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.sharedTaskRecovery.cancel })); });
    first.unmount();
    const reopened = await setup(true, first.initialProps.sessionId);
    expect(screen.queryByText(en.sharedTaskRecovery.title)).toBeNull();
    await act(async () => { reopened.result.current.askAgain?.(); });
    await screen.findByText(en.sharedTaskRecovery.title);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.sharedTaskRecovery.cancel })); });
    reopened.unmount();
    // A later terminal episode with the same text must still be offered.
    makerChatStore.__applyStreamEventForTest(first.initialProps.sessionId, {
      sessionId: first.initialProps.sessionId, type: 'error', source: 'codex',
      data: { message: first.initialProps.error },
    });
    await setup(true, first.initialProps.sessionId);
    await screen.findByText(en.sharedTaskRecovery.title);
  });
  it('keeps an account-cycle usage limit in the existing wait and reset workflow', async () => {
    const h = await setup(false);
    h.rerender({ ...h.initialProps, active: true, handledUsageLimit: true, error: '429 usage_limit: usage limit reached' });
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByText(en.sharedTaskRecovery.title)).toBeNull();
    expect(h.result.current.askAgain).toBeUndefined();
  });
  it('explains the actual stage, opens the existing picker only after consent, and does not carry that request to another task', async () => {
    const h = await setup();
    await screen.findByText(en.sharedTaskRecovery.title);
    expect(screen.getByText(/Failed while installing execution authorization/)).toBeTruthy();
    expect(h.result.current.modelPickerRequest).toBe(0);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.sharedTaskRecovery.choose })); });
    await waitFor(() => expect(h.result.current.modelPickerRequest).toBe(1));
    await act(async () => h.result.current.consumeModelPickerRequest(1));
    expect(h.result.current.modelPickerRequest).toBe(0);
    h.rerender({ ...h.initialProps });
    expect(h.result.current.modelPickerRequest).toBe(0);
    expect(screen.queryByText(en.sharedTaskRecovery.title)).toBeNull();
    h.rerender({ ...h.initialProps, sessionId: 'history-b', active: false });
    expect(h.result.current.modelPickerRequest).toBe(0);
  });

  it('waits for silent recovery to end, and aborts a pending choice when the task changes', async () => {
    const h = await setup(false);
    await act(async () => {});
    expect(screen.queryByText(en.sharedTaskRecovery.title)).toBeNull();
    await act(async () => { h.rerender({ ...h.initialProps, active: true }); });
    await screen.findByText(en.sharedTaskRecovery.title);
    h.rerender({ ...h.initialProps, sessionId: 'history-b', error: '', active: true });
    await waitFor(() => expect(screen.queryByText(en.sharedTaskRecovery.title)).toBeNull());
    expect(h.result.current.modelPickerRequest).toBe(0);
  });

  it('allows staying on the original task without repeatedly prompting, and keeps a manual exit', async () => {
    const h = await setup();
    const cancel = await screen.findByRole('button', { name: en.sharedTaskRecovery.cancel });
    await act(async () => { fireEvent.click(cancel); });
    expect(h.result.current.modelPickerRequest).toBe(0);
    h.rerender({ ...h.initialProps });
    expect(screen.queryByText(en.sharedTaskRecovery.title)).toBeNull();
    await act(async () => { h.result.current.askAgain?.(); });
    await screen.findByText(en.sharedTaskRecovery.title);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.sharedTaskRecovery.cancel })); });
  });
});

// #10187, unit: raw guest-ownership rejection must reach the existing dialog
// and model picker. Cancelling cannot trigger an automatic replay or route change.
it.each([true, false])('offers shared resume recovery and respects acceptance=%s', async accepted => {
  const h = await setup(false);
  h.rerender({ ...h.initialProps, active: true,
    error: 'LAZY_CREATE_FAILED: [REMOTE_AGENT_INVALID] this conversation cannot be resumed on this computer' });
  await screen.findByText(en.sharedTaskRecovery.title);
  expect(screen.getByText(text => text.includes(en.sharedTaskRecovery.reason.history))).toBeTruthy();
  expect(h.result.current.modelPickerRequest).toBe(0);
  await act(async () => { fireEvent.click(screen.getByRole('button', {
    name: accepted ? en.sharedTaskRecovery.choose : en.sharedTaskRecovery.cancel,
  })); });
  expect(h.result.current.modelPickerRequest).toBe(accepted ? 1 : 0);
});
