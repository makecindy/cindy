// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InputHandoffSnapshot } from '@cindy/device-link';

import { InputHandoffCard } from '../InputHandoffCard';

const mocks = vi.hoisted(() => ({
  answer: vi.fn(async () => ({ accepted: true })),
  close: vi.fn(),
  open: vi.fn(),
  resolve: vi.fn(async () => ({ accepted: true })),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/contexts/AuthContext', () => ({
  useOptionalAuthDeviceId: () => 'this-device',
}));
vi.mock('@/lib/makerTransport', () => ({
  submitInputHandoff: vi.fn(),
  openInputHandoffPicture: mocks.open,
  makerApiForSticky: () => ({ resolveInteraction: mocks.resolve }),
}));

beforeEach(() => {
  mocks.open.mockImplementation(async () => ({
    picture: { mime: 'image/jpeg', width: 800, height: 600, data: 'AAAA' },
    answer: mocks.answer,
    close: mocks.close,
  }));
  vi.spyOn(HTMLImageElement.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 10, top: 20, width: 400, height: 300, right: 410, bottom: 320, x: 10, y: 20, toJSON: () => ({}),
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

let nextRequest = 0;
const shot = (overrides: Partial<InputHandoffSnapshot> = {}): InputHandoffSnapshot => ({
  kind: 'input_handoff',
  requestId: `req${nextRequest}`,
  revision: 4,
  phase: 'ready',
  purpose: 'Sign in to Game',
  source: { app: 'Game', window: 'Game' },
  stepNumber: 1,
  remoteInput: true,
  controls: [],
  picture: true,
  ...overrides,
});

const fill = () => fireEvent.click(screen.getByRole('button', { name: 'inputHandoff.action.fill' }));

describe('InputHandoffCard screenshot step', () => {
  beforeEach(() => {
    nextRequest++;
  });

  it('opens a fresh picture after a tap that did not go through, so the next tap works', async () => {
    mocks.answer.mockResolvedValueOnce({ accepted: false });
    render(<InputHandoffCard sessionId="s1" snapshot={shot()} />);
    fill();
    fireEvent.click(await screen.findByRole('button', { name: 'inputHandoff.picture.alt' }), { clientX: 110, clientY: 245 });
    await waitFor(() => expect(mocks.open).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('inputHandoff.error.stale')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'inputHandoff.picture.alt' }), { clientX: 110, clientY: 245 });
    await waitFor(() => expect(mocks.answer).toHaveBeenCalledTimes(2));
  });

  it('closes a picture that arrives after the dialog was closed', async () => {
    let arrive: (value: unknown) => void = () => undefined;
    mocks.open.mockImplementationOnce(() => new Promise((resolve) => { arrive = resolve; }));
    const view = render(<InputHandoffCard sessionId="s1" snapshot={shot()} />);
    fill();
    await waitFor(() => expect(mocks.open).toHaveBeenCalledTimes(1));
    view.unmount();
    arrive({ picture: { mime: 'image/jpeg', width: 800, height: 600, data: 'AAAA' }, answer: mocks.answer, close: mocks.close });
    await waitFor(() => expect(mocks.close).toHaveBeenCalledTimes(1));
  });

  it('shows the picture once the owner opens the step, and sends a tap as a fraction', async () => {
    render(<InputHandoffCard sessionId="s1" snapshot={shot()} />);
    expect(mocks.open).not.toHaveBeenCalled();
    fill();
    const image = await screen.findByRole('button', { name: 'inputHandoff.picture.alt' });
    expect(mocks.open).toHaveBeenCalledWith('s1', expect.objectContaining({ picture: true, revision: 4 }));
    fireEvent.click(image, { clientX: 110, clientY: 245 });
    await waitFor(() => expect(mocks.answer).toHaveBeenCalledWith({
      expectedRevision: 4,
      values: {},
      action: { kind: 'tap', x: 0.25, y: 0.75 },
    }));
    // No quiet take-over: that would move the revision under the picture.
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it('fetches nothing for a task on another computer until the owner opens the step', async () => {
    render(<InputHandoffCard sessionId="s1" snapshot={shot()} remote />);
    expect(mocks.open).not.toHaveBeenCalled();
    fill();
    await screen.findByRole('button', { name: 'inputHandoff.picture.alt' });
    expect(mocks.open).toHaveBeenCalledTimes(1);
  });

  it('types into the focused field with the platform password field', async () => {
    const snapshot = shot({ controls: [{ id: 'typed', kind: 'text', label: '', contentType: 'password' }] });
    render(<InputHandoffCard sessionId="s1" snapshot={snapshot} />);
    fill();
    const field = (await screen.findByLabelText('inputHandoff.passwordField')) as HTMLInputElement;
    expect(field.type).toBe('password');
    fireEvent.change(field, { target: { value: 'synthetic-pass' } });
    fireEvent.click(screen.getByRole('button', { name: 'inputHandoff.picture.typeEnter' }));
    await waitFor(() => expect(mocks.answer).toHaveBeenCalledWith({
      expectedRevision: 4,
      values: { typed: 'synthetic-pass' },
      action: { kind: 'submit' },
    }));
    await waitFor(() => expect(field.value).toBe(''));
  });

  it('closes the exchange when the step moves on and opens the next one by itself', async () => {
    const { rerender } = render(<InputHandoffCard sessionId="s1" snapshot={shot()} remote />);
    fill();
    await screen.findByRole('button', { name: 'inputHandoff.picture.alt' });
    rerender(<InputHandoffCard sessionId="s1" snapshot={shot({ revision: 6 })} remote />);
    expect(mocks.close).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(mocks.open).toHaveBeenCalledTimes(2));
    expect(mocks.open).toHaveBeenLastCalledWith('s1', expect.objectContaining({ revision: 6 }));
  });

  it('goes back to the form with a value-less decision', async () => {
    render(<InputHandoffCard sessionId="s1" snapshot={shot()} />);
    fill();
    fireEvent.click(await screen.findByRole('button', { name: 'inputHandoff.action.backToForm' }));
    await waitFor(() => expect(mocks.resolve).toHaveBeenCalledWith(expect.any(String), {
      kind: 'input_handoff',
      action: 'refresh',
      expectedRevision: 4,
    }));
  });

  it('offers the picture from a form step', async () => {
    const form = shot({
      picture: undefined,
      controls: [{ id: 'c0', kind: 'text', label: 'Nickname', contentType: 'text' }],
    });
    render(<InputHandoffCard sessionId="s1" snapshot={form} />);
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'inputHandoff.action.picture' }));
    await waitFor(() => expect(mocks.resolve).toHaveBeenCalledWith(form.requestId, {
      kind: 'input_handoff',
      action: 'picture',
      expectedRevision: 4,
    }));
    expect(mocks.open).not.toHaveBeenCalled();
  });
});
