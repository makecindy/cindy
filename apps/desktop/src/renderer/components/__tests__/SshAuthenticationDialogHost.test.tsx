// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SshAuthenticationRequest } from '../../../shared/sshAuthentication';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
import { SshAuthenticationDialogHost, SshAuthenticationForm } from '../SshAuthenticationDialogHost';
// Test value (unit, DOM): the real host/form must mask and discard fake input,
// submit once, and keep a dismissed challenge out of a delayed initial snapshot.
// OTP UI is new; broker tests cannot observe DOM input or IME behavior. Minimal
// failures are an echo=true prompt, a dismiss-before-list race, and composing Enter.
// Use a lightweight DOM environment to keep the new file within the 5s budget;
// render the actual Radix dialog, Input, FormField and Button without replacements.
const request: SshAuthenticationRequest = {
  requestId: 'request-1', expiresAt: Date.now() + 120_000,
  host: { id: 'test', user: 'test', hostname: 'example.test', port: 22 },
  name: 'MFA', instructions: '<script>server text</script>', prompts: [{ prompt: 'Code', echo: false }],
};
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('SSH authentication secret form', () => {
  it('does not restore a request dismissed while the initial snapshot was loading', async () => {
    let dismiss!: (id: string) => void;
    let complete!: (requests: SshAuthenticationRequest[]) => void;
    const answerAuthentication = vi.fn(async () => ({ accepted: true }));
    vi.stubGlobal('electronAPI', { remoteSsh: {
      onAuthenticationRequest: () => () => {},
      onAuthenticationDismissed: (callback: (id: string) => void) => { dismiss = callback; return () => {}; },
      getPendingAuthentication: () => new Promise<SshAuthenticationRequest[]>(resolve => { complete = resolve; }),
      answerAuthentication,
    } });
    render(<SshAuthenticationDialogHost />);
    await act(async () => { dismiss(request.requestId); complete([request]); });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(answerAuthentication).not.toHaveBeenCalled();
  });

  it('clears the old form when Main dismisses it and queues a separate host without reusing input', async () => {
    let push!: (request: SshAuthenticationRequest) => void;
    let dismiss!: (id: string) => void;
    const answerAuthentication = vi.fn(async (_id: string, _answers: string[] | null) => ({ accepted: true }));
    vi.stubGlobal('electronAPI', { remoteSsh: {
      onAuthenticationRequest: (callback: typeof push) => { push = callback; return () => {}; },
      onAuthenticationDismissed: (callback: typeof dismiss) => { dismiss = callback; return () => {}; },
      getPendingAuthentication: async () => [], answerAuthentication,
    } });
    render(<SshAuthenticationDialogHost />);
    await act(async () => {
      push(request); push({ ...request, requestId: 'second', host: { ...request.host, id: 'second-host' } });
    });
    fireEvent.change(screen.getByLabelText('Code'), { target: { value: 'FAKE-FIRST-HOST' } });
    await act(async () => { dismiss(request.requestId); });
    expect((screen.getByLabelText('Code') as HTMLInputElement).value).toBe('');
    expect(answerAuthentication).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'logic.confirm.cancel' }));
    await act(async () => {});
    expect(answerAuthentication).toHaveBeenCalledWith('second', null);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  // JumpServer can request echo=true for OTP; privacy must not depend on that flag.
  it.each([false, true])('masks and focuses input (server echo=%s), shows server text literally, and submits only once', async echo => {
    const delivered: string[][] = [];
    const answer = vi.fn(async (_id: string, values: string[] | null) => { if (values) delivered.push([...values]); });
    render(<SshAuthenticationForm request={{ ...request, prompts: [{ prompt: 'Code', echo }] }} onAnswer={answer} />);
    const input = screen.getByLabelText('Code') as HTMLInputElement;
    expect(input.type).toBe('password');
    expect(document.activeElement).toBe(input);
    expect(screen.getByText('<script>server text</script>')).toBeTruthy();
    fireEvent.change(input, { target: { value: 'FAKE-OTP' } });
    const form = input.closest('form')!;
    fireEvent.submit(form); fireEvent.submit(form);
    await act(async () => {});
    expect(answer).toHaveBeenCalledTimes(1);
    expect(delivered).toEqual([['FAKE-OTP']]);
    expect(input.value).toBe('');
    expect(answer.mock.calls[0][1]).toEqual(['']);
  });

  it('does not submit while composing, then cancels without sending the typed value', async () => {
    const answer = vi.fn(async () => {});
    render(<SshAuthenticationForm request={request} onAnswer={answer} />);
    const input = screen.getByLabelText('Code');
    fireEvent.change(input, { target: { value: 'FAKE-SECRET' } });
    fireEvent.compositionStart(input);
    fireEvent.submit(input.closest('form')!);
    expect(answer).not.toHaveBeenCalled();
    fireEvent.compositionEnd(input);
    fireEvent.click(screen.getByRole('button', { name: 'logic.confirm.cancel' }));
    await act(async () => {});
    expect(answer).toHaveBeenCalledWith(request.requestId, null);
    expect((input as HTMLInputElement).value).toBe('');
  });

  it('expires without submitting a secret and a new request starts empty', async () => {
    vi.useFakeTimers();
    const answer = vi.fn(async () => {});
    const view = render(<SshAuthenticationForm key={request.requestId} request={{ ...request, expiresAt: Date.now() + 120_000 }} onAnswer={answer} />);
    fireEvent.change(screen.getByLabelText('Code'), { target: { value: 'FAKE-EXPIRED' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(answer).toHaveBeenCalledWith(request.requestId, null);
    view.rerender(<SshAuthenticationForm key="request-2" request={{ ...request, requestId: 'request-2', expiresAt: Date.now() + 120_000 }} onAnswer={answer} />);
    expect((screen.getByLabelText('Code') as HTMLInputElement).value).toBe('');
  });
});
