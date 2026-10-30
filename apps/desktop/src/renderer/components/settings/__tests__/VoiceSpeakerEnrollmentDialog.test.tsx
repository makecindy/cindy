// @vitest-environment jsdom

import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ permission: vi.fn(), record: vi.fn(), enroll: vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn() } }));
vi.mock('@/voice-input/startGuards', () => ({ requestRendererMicrophonePermission: mocks.permission }));
vi.mock('@/voice-input/speakerEnrollmentRecorder', () => ({
  recordSpeakerEnrollmentClip: mocks.record,
  SpeakerEnrollmentAbortedError: class extends Error {},
  SpeakerEnrollmentNoAudioError: class extends Error {},
}));

import { VoiceSpeakerEnrollmentDialog } from '../VoiceSpeakerEnrollmentDialog';

const key = (name: string) => `settings.voiceInput.speakerFilter.enroll.${name}`;
function Harness() {
  const [open, setOpen] = useState(false);
  return <>
    <button onClick={() => setOpen(true)}>Enroll</button>
    <VoiceSpeakerEnrollmentDialog open={open} onOpenChange={setOpen} microphoneDeviceId={null} onEnrolled={vi.fn()} />
  </>;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function openDialog() {
  const opener = screen.getByRole('button', { name: 'Enroll' });
  opener.focus();
  fireEvent.click(opener);
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: key('record') })));
  return opener;
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.permission.mockResolvedValue({ ok: true });
  mocks.record.mockResolvedValue(new ArrayBuffer(8));
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { voiceInput: { speakerFilter: { enroll: mocks.enroll } } } });
});
afterEach(cleanup);

describe('VoiceSpeakerEnrollmentDialog', () => {
  it('lets the user finish each clip early, then submit the three captured clips', async () => {
    const clips: ArrayBuffer[] = [];
    mocks.record.mockImplementation((options) => {
      expect(options.durationMs).toBe(30_000);
      options.onProgress(0.4);
      return new Promise<ArrayBuffer>((resolve) => {
        options.stopSignal.addEventListener('abort', () => {
          expect(options.signal.aborted).toBe(false);
          const clip = new ArrayBuffer(12 * 16_000 * 2);
          clips.push(clip);
          resolve(clip);
        }, { once: true });
      });
    });
    mocks.enroll.mockResolvedValue({ ok: true, status: {} });
    render(<Harness />);
    await openDialog();
    for (let index = 0; index < 3; index += 1) {
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: key('record') })); });
      expect(screen.getByRole('button', { name: key('submit') }).hasAttribute('disabled')).toBe(true);
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: key('stop') })); });
    }
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: key('submit') })); });
    expect(mocks.enroll).toHaveBeenCalledExactlyOnceWith(clips);
  });

  it('restores the opener after cancelling', async () => {
    render(<Harness />);
    const opener = await openDialog();
    fireEvent.click(screen.getByRole('button', { name: key('cancel') }));
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it('does not start recording when permission resolves after cancellation and reopening', async () => {
    const permission = deferred<{ ok: true }>();
    mocks.permission.mockReturnValueOnce(permission.promise);
    render(<Harness />);
    await openDialog();
    fireEvent.click(screen.getByRole('button', { name: key('record') }));
    fireEvent.click(screen.getByRole('button', { name: key('cancel') }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await openDialog();
    await act(async () => { permission.resolve({ ok: true }); });
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it('does not start recording after unmounting during permission request', async () => {
    const permission = deferred<{ ok: true }>();
    mocks.permission.mockReturnValueOnce(permission.promise);
    const view = render(<Harness />);
    await openDialog();
    fireEvent.click(screen.getByRole('button', { name: key('record') }));
    view.unmount();
    await act(async () => { permission.resolve({ ok: true }); });
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it('ignores repeated activation while waiting for microphone permission', async () => {
    const permission = deferred<{ ok: true }>();
    mocks.permission.mockReturnValue(permission.promise);
    render(<Harness />);
    await openDialog();
    const record = screen.getByRole('button', { name: key('record') });
    fireEvent.click(record);
    fireEvent.click(record);
    await act(async () => { permission.resolve({ ok: true }); });
    expect(mocks.permission).toHaveBeenCalledTimes(1);
    expect(mocks.record).toHaveBeenCalledTimes(1);
  });

  it('focuses the next recording, then submit, and the rejected passage on validation failure', async () => {
    const enrollment = deferred<{ ok: false; reason: 'inconsistent'; clipIndex: number }>();
    mocks.enroll.mockReturnValue(enrollment.promise);
    render(<Harness />);
    await openDialog();
    for (let index = 0; index < 3; index += 1) {
      const clip = deferred<ArrayBuffer>();
      mocks.record.mockReturnValueOnce(clip.promise);
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: key('record') })); });
      await act(async () => { clip.resolve(new ArrayBuffer(8)); });
      expect(document.activeElement).toBe(screen.getByRole('button', { name: key(index === 2 ? 'submit' : 'record') }));
    }
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: key('submit') })); });
    await act(async () => { enrollment.resolve({ ok: false, reason: 'inconsistent', clipIndex: 1 }); });
    expect(screen.getByRole('alert').textContent).toBe(key('errors.inconsistent'));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: key('record') }));
  });
});
