// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InputHandoffSnapshot } from '@cindy/device-link';

import { InputHandoffCard } from '../InputHandoffCard';

const mocks = vi.hoisted(() => ({
  submit: vi.fn(async () => ({ accepted: true })),
  resolve: vi.fn(async () => ({ accepted: true })),
  deviceId: null as string | null,
  hostDeviceId: undefined as string | undefined,
  openRemoteDesktop: vi.fn(async () => {}),
  openPicture: vi.fn(),
  answer: vi.fn(async () => ({ accepted: true })),
  close: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/contexts/AuthContext', () => ({
  useOptionalAuthDeviceId: () => mocks.deviceId,
}));
vi.mock('@/features/device-link/stickySessionOrigin', () => ({
  getStickySessionDeviceId: () => mocks.hostDeviceId,
}));
vi.mock('@/features/device-link/useDeviceLinkDeviceList', () => ({
  useDeviceLinkDeviceList: () => [{ deviceId: 'mac', name: 'Studio' }],
}));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/lib/makerTransport', () => ({
  submitInputHandoff: mocks.submit,
  makerApiForSticky: () => ({ resolveInteraction: mocks.resolve }),
  openInputHandoffPicture: mocks.openPicture,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.deviceId = null;
  mocks.hostDeviceId = undefined;
});

const step = (overrides: Partial<InputHandoffSnapshot> = {}): InputHandoffSnapshot => ({
  kind: 'input_handoff',
  requestId: 'req1',
  revision: 4,
  phase: 'ready',
  purpose: 'Sign in to Example',
  source: { app: 'Example', window: 'Sign in' },
  stepNumber: 1,
  remoteInput: true,
  controls: [
    { id: 'c0', kind: 'text', label: 'Email', contentType: 'email' },
    { id: 'c1', kind: 'text', label: 'Password', contentType: 'password' },
  ],
  ...overrides,
});

const fill = (name = 'inputHandoff.action.fill') => fireEvent.click(screen.getByRole('button', { name }));

describe('InputHandoffCard', () => {
  it('sits above the composer as one line, and opens the fields only when asked', () => {
    render(<InputHandoffCard sessionId="s1" snapshot={step({ source: { app: 'Google Chrome', origin: 'https://login.example.com' } })} />);
    expect(screen.getByText('Sign in to Example')).toBeTruthy();
    expect(screen.getByText('login.example.com')).toBeTruthy();
    expect(screen.queryByLabelText('Password')).toBeNull();
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual([
      'inputHandoff.action.skip',
      'inputHandoff.action.fill',
    ]);
    fill();
    expect(screen.getByTestId('input-handoff-dialog')).toBeTruthy();
    expect(screen.getByLabelText('Password')).toBeTruthy();
  });

  it('skips with a value-less decision', async () => {
    render(<InputHandoffCard sessionId="s1" snapshot={step()} />);
    fireEvent.click(screen.getByRole('button', { name: 'inputHandoff.action.skip' }));
    await waitFor(() =>
      expect(mocks.resolve).toHaveBeenCalledWith('req1', { kind: 'input_handoff', action: 'cancel', expectedRevision: 4 }),
    );
  });

  it('renders standard autofill fields so password managers can fill them', () => {
    render(<InputHandoffCard sessionId="s1" snapshot={step()} />);
    fill();
    const password = screen.getByLabelText('Password') as HTMLInputElement;
    expect(password.type).toBe('password');
    expect(password.autocomplete).toBe('current-password');
    const email = screen.getByLabelText('Email') as HTMLInputElement;
    expect(email.type).toBe('email');
    expect(email.autocomplete).toBe('email');
    // The eye only shows the password; the autofill hint stays.
    fireEvent.click(screen.getByRole('button', { name: 'inputHandoff.action.showPassword' }));
    expect(password.type).toBe('text');
    expect(password.autocomplete).toBe('current-password');
  });

  it('moves through the fields on Return and sends what was typed from the last one, then clears it', async () => {
    render(<InputHandoffCard sessionId="s1" snapshot={step()} />);
    fill();
    const email = screen.getByLabelText('Email') as HTMLInputElement;
    const password = screen.getByLabelText('Password') as HTMLInputElement;
    fireEvent.change(email, { target: { value: 'someone@example.test' } });
    email.focus();
    fireEvent.submit(email.form!);
    expect(document.activeElement).toBe(password);
    expect(mocks.submit).not.toHaveBeenCalled();

    fireEvent.change(password, { target: { value: 'synthetic-pass' } });
    fireEvent.submit(password.form!);
    await waitFor(() => expect(mocks.submit).toHaveBeenCalledTimes(1));
    expect(mocks.submit).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({
        submission: {
          expectedRevision: 4,
          values: { c0: 'someone@example.test', c1: 'synthetic-pass' },
          action: { kind: 'submit' },
        },
      }),
    );
    await waitFor(() => expect(password.value).toBe(''));
  });

  it('shows only the fields to type and what the page says about them, and Continue sends them', async () => {
    render(
      <InputHandoffCard
        sessionId="s1"
        snapshot={step({ controls: [{ id: 'n0', kind: 'note', tone: 'error', text: 'Wrong password' }, ...step().controls] })}
      />,
    );
    fill();
    expect(screen.getByRole('alert').textContent).toBe('Wrong password');
    const dialog = screen.getByTestId('input-handoff-dialog');
    expect([...dialog.querySelectorAll('button:not([aria-hidden])')].map((b) => b.getAttribute('aria-label') ?? b.textContent)).toEqual([
      'inputHandoff.action.showPassword',
      'inputHandoff.action.continue',
      'inputHandoff.action.close',
      'inputHandoff.action.picture',
    ]);
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'someone@example.test' } });
    // Continue answers from any field, unlike Return in an earlier one.
    screen.getByLabelText('Email').focus();
    fireEvent.click(screen.getByRole('button', { name: 'inputHandoff.action.continue' }));
    await waitFor(() => expect(mocks.submit).toHaveBeenCalledTimes(1));
    // Cancel only closes the dialog; the handoff stays on the strip.
    fireEvent.click(screen.getByRole('button', { name: 'inputHandoff.action.close' }));
    expect(screen.queryByTestId('input-handoff-dialog')).toBeNull();
    expect(mocks.resolve).not.toHaveBeenCalledWith('req1', expect.objectContaining({ action: 'cancel' }));
  });

  it('hands back with a value-less decision', async () => {
    render(
      <InputHandoffCard
        sessionId="s1"
        snapshot={step({ phase: 'finishing', finishingUntil: Date.now() + 3000 })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'inputHandoff.action.done' }));
    await waitFor(() =>
      expect(mocks.resolve).toHaveBeenCalledWith('req1', {
        kind: 'input_handoff',
        action: 'done',
        expectedRevision: 4,
      }),
    );
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it('starts a new screen from an empty draft, in the dialog that stays open', () => {
    const { rerender } = render(<InputHandoffCard sessionId="s1" snapshot={step()} />);
    fill();
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'someone@example.test' } });
    rerender(<InputHandoffCard sessionId="s1" snapshot={step({ revision: 5, stepNumber: 2 })} />);
    expect((screen.getByLabelText('Email') as HTMLInputElement).value).toBe('');
  });

  it('starts handling quietly on the first keystroke without blocking the form', async () => {
    render(<InputHandoffCard sessionId="s1" snapshot={step()} />);
    fill();
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 's' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'so' } });
    await waitFor(() => expect(mocks.resolve).toHaveBeenCalledTimes(1));
    expect(mocks.resolve).toHaveBeenCalledWith('req1', {
      kind: 'input_handoff',
      action: 'claim',
      expectedRevision: 4,
    });
    expect((screen.getByLabelText('Email') as HTMLInputElement).disabled).toBe(false);
  });

  it('keeps what the owner is typing when another device was taken over', () => {
    const { rerender } = render(<InputHandoffCard sessionId="s1" snapshot={step()} />);
    fill();
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'someone@example.test' } });
    rerender(
      <InputHandoffCard sessionId="s1" snapshot={step({ revision: 5, holder: { local: true } })} />,
    );
    expect((screen.getByLabelText('Email') as HTMLInputElement).value).toBe('someone@example.test');
  });

  it('shows who is handling it elsewhere and lets this device take over', async () => {
    mocks.deviceId = 'desk-2';
    render(
      <InputHandoffCard
        sessionId="s1"
        snapshot={step({
          holder: { deviceId: 'phone-1', name: 'Synthetic Phone', platform: 'mobile' },
        })}
      />,
    );
    expect(screen.getByText('inputHandoff.holder.elsewhere')).toBeTruthy();
    expect(screen.queryByLabelText('Password')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'inputHandoff.action.claim' }));
    await waitFor(() =>
      expect(mocks.resolve).toHaveBeenCalledWith('req1', {
        kind: 'input_handoff',
        action: 'claim',
        expectedRevision: 4,
      }),
    );
  });

  it('shows a terminal password prompt as one answer to one program', async () => {
    render(
      <InputHandoffCard
        sessionId="s1"
        snapshot={step({
          purpose: '[sudo] password for someone:',
          source: { app: 'sudo' },
          command: 'sudo -A true',
          controls: [{ id: 'answer', kind: 'text', label: '', contentType: 'password' }],
        })}
      />,
    );
    fill();
    expect(screen.getByText('sudo -A true')).toBeTruthy();
    const field = screen.getByLabelText('inputHandoff.passwordField') as HTMLInputElement;
    expect(field.type).toBe('password');
    for (const hidden of ['picture', 'done']) {
      expect(screen.queryByRole('button', { name: `inputHandoff.action.${hidden}` })).toBeNull();
    }
    fireEvent.change(field, { target: { value: 'synthetic-pass' } });
    fireEvent.submit(field.form!);
    await waitFor(() =>
      expect(mocks.submit).toHaveBeenCalledWith(
        's1',
        expect.objectContaining({
          submission: {
            expectedRevision: 4,
            values: { answer: 'synthetic-pass' },
            action: { kind: 'submit' },
          },
        }),
      ),
    );
  });

  it('opens a live view of just this window on the computer running the task', async () => {
    (window as unknown as { electronAPI: object }).electronAPI = {
      openRemoteDesktop: mocks.openRemoteDesktop,
    };
    const { rerender } = render(
      <InputHandoffCard sessionId="s1" snapshot={step({ liveView: true })} />,
    );
    // A task on this computer: the window is right here.
    expect(screen.queryByRole('button', { name: 'inputHandoff.action.liveView' })).toBeNull();
    mocks.hostDeviceId = 'mac';
    rerender(<InputHandoffCard sessionId="s1" snapshot={step()} />);
    expect(screen.queryByRole('button', { name: 'inputHandoff.action.liveView' })).toBeNull();
    rerender(<InputHandoffCard sessionId="s1" snapshot={step({ liveView: true })} />);
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'inputHandoff.action.liveView' }));
    await waitFor(() =>
      expect(mocks.openRemoteDesktop).toHaveBeenCalledWith({
        deviceId: 'mac',
        name: 'Studio',
        handoff: 'req1',
      }),
    );
  });

  it('offers a sign-in code to copy and its link to open on this device', async () => {
    const openExternal = vi.fn(async () => ({ success: true }));
    const writeText = vi.fn(async () => {});
    (window as unknown as { electronAPI: object }).electronAPI = { openExternal };
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const codeStep = step({
      controls: [],
      deviceCode: { code: 'WDJB-MJHT', url: 'https://github.com/login/device', origin: 'https://github.com' },
    });
    const { rerender } = render(<InputHandoffCard sessionId="s1" snapshot={codeStep} />);
    fill();
    expect(screen.getByText('WDJB-MJHT')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'inputHandoff.deviceCode.copy' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('WDJB-MJHT'));
    fireEvent.click(screen.getByRole('button', { name: /inputHandoff\.deviceCode\.open/ }));
    await waitFor(() => expect(openExternal).toHaveBeenCalledWith('https://github.com/login/device'));
    // A link whose shown origin does not match is never offered.
    rerender(
      <InputHandoffCard
        sessionId="s1"
        snapshot={{ ...codeStep, deviceCode: { ...codeStep.deviceCode!, origin: 'https://example.com' } }}
      />,
    );
    expect(screen.queryByRole('button', { name: 'inputHandoff.deviceCode.copy' })).toBeNull();
  });

  describe('scan-to-sign-in', () => {
    const qrStep = (overrides: Partial<InputHandoffSnapshot> = {}) =>
      step({ controls: [], picture: true, qr: 'scan', source: { app: 'Google Chrome', origin: 'https://login.example.com' }, ...overrides });
    const answerWith = (text: string, url?: string) =>
      mocks.openPicture.mockImplementation(async () => ({
        picture: { mime: 'image/jpeg', width: 360, height: 360, data: 'Y29kZQ==', qr: { text, ...(url ? { url } : {}) } },
        answer: mocks.answer,
        close: mocks.close,
      }));

    it('shows the code from the computer, opens its link here first, copies it, and clicks it there', async () => {
      const link = 'https://login.example.com/qr?t=1';
      answerWith(link, link);
      const openExternal = vi.fn(async () => ({ success: true }));
      const writeText = vi.fn(async () => {});
      (window as unknown as { electronAPI: object }).electronAPI = { openExternal };
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
      vi.spyOn(HTMLImageElement.prototype, 'getBoundingClientRect').mockReturnValue({
        left: 0, top: 0, width: 240, height: 240, right: 240, bottom: 240, x: 0, y: 0, toJSON: () => ({}),
      });
      render(<InputHandoffCard sessionId="s1" snapshot={qrStep()} />);
      // Nothing is fetched until the owner opens it.
      expect(mocks.openPicture).not.toHaveBeenCalled();
      fill('inputHandoff.action.scan');
      const code = await screen.findByTestId('input-handoff-qr-code');
      const actions = screen.getAllByRole('button').map((b) => b.textContent);
      expect(actions.indexOf('inputHandoff.qr.open')).toBeLessThan(actions.indexOf('inputHandoff.qr.copyImage'));
      fireEvent.click(screen.getByRole('button', { name: 'inputHandoff.qr.open' }));
      await waitFor(() => expect(openExternal).toHaveBeenCalledWith(link));
      fireEvent.click(screen.getByRole('button', { name: 'inputHandoff.qr.copyLink' }));
      await waitFor(() => expect(writeText).toHaveBeenCalledWith(link));
      fireEvent.click(code, { clientX: 120, clientY: 60 });
      await waitFor(() =>
        expect(mocks.answer).toHaveBeenCalledWith({ expectedRevision: 4, values: {}, action: { kind: 'tap', x: 0.5, y: 0.25 } }),
      );
      vi.restoreAllMocks();
    });

    it('leaves an app link to the phone that scans it, and content that is not a link to copy', async () => {
      answerWith('weixin://dl/login?t=1', 'weixin://dl/login?t=1');
      const { unmount } = render(<InputHandoffCard sessionId="s1" snapshot={qrStep()} />);
      fill('inputHandoff.action.scan');
      await screen.findByTestId('input-handoff-qr-code');
      expect(screen.queryByRole('button', { name: 'inputHandoff.qr.open' })).toBeNull();
      expect(screen.getByRole('button', { name: 'inputHandoff.qr.copyLink' })).toBeTruthy();
      unmount();
      answerWith('WIFI:S:home;;');
      render(<InputHandoffCard sessionId="s1" snapshot={qrStep({ requestId: 'req2' })} />);
      fill('inputHandoff.action.scan');
      await screen.findByTestId('input-handoff-qr-code');
      expect(screen.getByRole('button', { name: 'inputHandoff.qr.copyText' })).toBeTruthy();
    });

    it('waits on the strip once the code was scanned, and loads a refreshed code by itself', async () => {
      answerWith('https://login.example.com/qr?t=1', 'https://login.example.com/qr?t=1');
      const { rerender } = render(<InputHandoffCard sessionId="s1" snapshot={qrStep()} />);
      fill('inputHandoff.action.scan');
      await screen.findByTestId('input-handoff-qr-code');
      rerender(<InputHandoffCard sessionId="s1" snapshot={qrStep({ revision: 5 })} />);
      await waitFor(() => expect(mocks.openPicture).toHaveBeenCalledTimes(2));
      expect(mocks.close).toHaveBeenCalledTimes(1);
      rerender(<InputHandoffCard sessionId="s1" snapshot={qrStep({ revision: 6, qr: 'scanned', picture: undefined })} />);
      expect(screen.queryByTestId('input-handoff-dialog')).toBeNull();
      expect(screen.getByText('inputHandoff.qr.scanned')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'inputHandoff.action.done' }));
      await waitFor(() =>
        expect(mocks.resolve).toHaveBeenCalledWith('req1', { kind: 'input_handoff', action: 'done', expectedRevision: 6 }),
      );
    });

    // ask_owner kind=scan with the agent's screenshot (2026-10-30): Cindy cannot see that
    // screen, so it says where the picture came from, never claims to continue by itself,
    // has nothing to tap, and the owner hands back after scanning.
    it('labels a code from the agent\'s screenshot and lets the owner hand back after scanning', async () => {
      answerWith('https://login.example.com/qr?t=1', 'https://login.example.com/qr?t=1');
      render(<InputHandoffCard sessionId="s1" snapshot={qrStep({ agentPicture: true, agentControlled: true, source: { app: 'Cindy', origin: 'https://login.example.com' } })} />);
      fill('inputHandoff.action.scan');
      const code = await screen.findByTestId('input-handoff-qr-code');
      expect(screen.getByText('inputHandoff.agentPicture')).toBeTruthy();
      expect(screen.queryByText('inputHandoff.agentControlled')).toBeNull();
      expect(screen.queryByText('inputHandoff.qr.hintLink')).toBeNull();
      expect(screen.queryByRole('button', { name: 'inputHandoff.action.picture' })).toBeNull();
      fireEvent.click(code, { clientX: 120, clientY: 60 });
      expect(mocks.answer).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: 'inputHandoff.action.done' }));
      await waitFor(() =>
        expect(mocks.resolve).toHaveBeenCalledWith('req1', { kind: 'input_handoff', action: 'done', expectedRevision: 4 }),
      );
    });
  });

  describe('a sign-in step', () => {
    const signIn = (overrides: Partial<InputHandoffSnapshot> = {}) => step({ directSignIn: true, ...overrides });
    const raise = vi.fn(async () => true);
    const stubDesktop = () => {
      Object.assign(window, { electronAPI: { maker: { raiseInputHandoff: raise }, openRemoteDesktop: mocks.openRemoteDesktop } });
    };

    it('sends the owner to the window on this computer, with no form', async () => {
      stubDesktop();
      render(<InputHandoffCard sessionId="s1" snapshot={signIn()} />);
      expect(screen.getByRole('status').textContent).toBe('inputHandoff.directSignIn.hint');
      expect(screen.queryByRole('button', { name: 'inputHandoff.action.fill' })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'inputHandoff.action.openWindow' }));
      await waitFor(() => expect(raise).toHaveBeenCalledWith('req1'));
      expect(mocks.resolve).toHaveBeenCalledWith('req1', expect.objectContaining({ action: 'claim', expectedRevision: 4 }));
    });

    it('opens the live view from another computer, and looks the same otherwise', async () => {
      stubDesktop();
      mocks.hostDeviceId = 'mac';
      render(<InputHandoffCard sessionId="s1" snapshot={signIn({ liveView: true })} />);
      expect(screen.getByRole('status').textContent).toBe('inputHandoff.directSignIn.hint');
      expect(screen.queryByRole('button', { name: 'inputHandoff.action.liveView' })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'inputHandoff.action.openRemoteDesktop' }));
      await waitFor(() => expect(mocks.openRemoteDesktop).toHaveBeenCalledWith({ deviceId: 'mac', name: 'Studio', handoff: 'req1' }));
      // Working on the window takes the card, so other devices show it as being handled.
      expect(mocks.resolve).toHaveBeenCalledWith('req1', expect.objectContaining({ action: 'claim', expectedRevision: 4 }));
    });

    it('lets the owner say when, if the page could not be read', () => {
      stubDesktop();
      render(<InputHandoffCard sessionId="s1" snapshot={signIn({ picture: true, controls: [] })} />);
      expect(screen.getByRole('status').textContent).toBe('inputHandoff.directSignIn.hintUnread');
      expect(screen.getByRole('button', { name: 'inputHandoff.action.openPlainWindow' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'inputHandoff.action.done' })).toBeTruthy();
    });

    it('offers the form when the window cannot be used, and shows an error when opening it did not work', async () => {
      stubDesktop();
      raise.mockResolvedValueOnce(false);
      render(<InputHandoffCard sessionId="s1" snapshot={signIn()} />);
      fireEvent.click(screen.getByRole('button', { name: 'inputHandoff.action.openWindow' }));
      await waitFor(() => expect(screen.getByText('inputHandoff.error.raise')).toBeTruthy());
      fireEvent.click(screen.getByRole('button', { name: 'inputHandoff.action.useForm' }));
      expect(screen.getByRole('button', { name: 'inputHandoff.action.fill' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'inputHandoff.action.openWindow' })).toBeNull();
    });

    it('keeps the form from another computer when there is no live view', () => {
      mocks.hostDeviceId = 'mac';
      render(<InputHandoffCard sessionId="s1" snapshot={signIn()} />);
      expect(screen.getByRole('button', { name: 'inputHandoff.action.fill' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'inputHandoff.action.openRemoteDesktop' })).toBeNull();
    });
  });
});
