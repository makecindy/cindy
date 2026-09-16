// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CindyMakeCreateDialog } from '../CindyMakeCreateDialog';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';

const mocks = vi.hoisted(() => ({
  ensureMakeTask: vi.fn<typeof import('@/lib/cindyMakeDoctorStream').ensureMakeTask>(),
  startMakeDoctorInStream:
    vi.fn<typeof import('@/lib/cindyMakeDoctorStream').startMakeDoctorInStream>(),
  getDraft: vi.fn(),
  getFastModeForModel: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('react-router-dom', () => ({ useNavigate: () => mocks.navigate }));
vi.mock('@/lib/cindyMakeDoctorStream', () => ({
  ensureMakeTask: mocks.ensureMakeTask,
  startMakeDoctorInStream: mocks.startMakeDoctorInStream,
}));
vi.mock('@/state/newMakerDraft', () => ({
  getDraft: mocks.getDraft,
  getFastModeForModel: mocks.getFastModeForModel,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function openDialog() {
  const onOpenChange = vi.fn();
  const view = render(<CindyMakeCreateDialog onOpenChange={onOpenChange} />);
  const input = screen.getByRole('textbox') as HTMLTextAreaElement;
  const submit = screen.getByRole('button', {
    name: 'settings.cindyMake.create.continue',
  }) as HTMLButtonElement;
  return { ...view, onOpenChange, input, submit };
}

beforeEach(() => {
  vi.resetAllMocks();
  setDataOwnerGeneration('owner-a', 1);
  mocks.ensureMakeTask.mockResolvedValue('make-task');
  mocks.startMakeDoctorInStream.mockReturnValue('make-run');
  mocks.getFastModeForModel.mockReturnValue(true);
  const prefs = {
    model: 'selected-model',
    effort: 'high',
    permissionMode: 'acceptEdits',
    providerId: 'selected-provider',
    planMode: true,
  };
  mocks.getDraft.mockReturnValue({
    vendor: 'codex',
    lastByVendor: { cc: prefs, codex: prefs, pi: prefs },
    workingDir: '/existing-project',
    remoteHostId: 'existing-ssh-host',
    deviceLinkDeviceId: 'existing-device',
    extraDirs: ['/existing-reference'],
    collab: { enabled: true },
  });
});

afterEach(() => {
  cleanup();
  setDataOwnerGeneration(null);
});

describe('Cindy Make creation from Settings', () => {
  it('focuses the requirements and creates nothing on opening or cancelling', () => {
    const view = openDialog();
    expect(document.activeElement).toBe(view.input);
    expect(view.submit.disabled).toBe(true);
    expect(view.input.maxLength).toBe(4000);
    fireEvent.click(screen.getByRole('button', { name: 'settings.cindyMake.create.cancel' }));
    expect(view.onOpenChange).toHaveBeenCalledWith(false);
    expect(mocks.ensureMakeTask).not.toHaveBeenCalled();
    expect(mocks.startMakeDoctorInStream).not.toHaveBeenCalled();
    expect(mocks.getDraft).not.toHaveBeenCalled();
  });

  it('allows Escape to dismiss before submitting', () => {
    const view = openDialog();
    fireEvent.keyDown(view.input, { key: 'Escape', isComposing: true });
    expect(view.onOpenChange).not.toHaveBeenCalled();
    fireEvent.keyDown(view.input, { key: 'Escape' });
    expect(view.onOpenChange).toHaveBeenCalledWith(false);
    expect(mocks.ensureMakeTask).not.toHaveBeenCalled();
  });

  it.each(['', '   ', 'x'.repeat(4001)])('rejects invalid requirements (%#)', async (request) => {
    const view = openDialog();
    fireEvent.change(view.input, { target: { value: request } });
    expect(view.submit.disabled).toBe(true);
    await act(async () => {
      fireEvent.submit(view.input.closest('form')!);
      fireEvent.keyDown(view.input, { key: 'Enter', ctrlKey: true });
    });
    expect(mocks.ensureMakeTask).not.toHaveBeenCalled();
    expect(mocks.startMakeDoctorInStream).not.toHaveBeenCalled();
  });

  it.each(['cc', 'codex', 'pi'])(
    'uses the shared workflow and %s preferences without modifying the existing draft',
    async (vendor) => {
      const draft = { ...mocks.getDraft(), vendor };
      mocks.getDraft.mockReturnValue(draft);
      const originalDraft = JSON.stringify(draft);
      const view = openDialog();
      const request = 'Add a task filter.\nKeep the existing layout.  ';
      fireEvent.change(view.input, { target: { value: request } });
      fireEvent.click(view.submit);

      await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith('/cc-agent/make-task'));
      expect(mocks.ensureMakeTask).toHaveBeenCalledExactlyOnceWith({
        sessionId: undefined,
        title: 'settings.cindyMake.create.title',
        isCurrent: expect.any(Function),
        createOptions: {
          workspaceKind: 'dialogue',
          agentKind: vendor,
          model: 'selected-model',
          effort: 'high',
          permissionMode: 'acceptEdits',
          providerId: 'selected-provider',
          fastMode: true,
          planModeEnabled: true,
        },
      });
      expect(mocks.startMakeDoctorInStream).toHaveBeenCalledExactlyOnceWith('make-task', {
        command: 'cindy-make',
        request,
      });
      expect(view.onOpenChange).toHaveBeenCalledWith(false);
      expect(JSON.stringify(draft)).toBe(originalDraft);
    },
  );

  it('coalesces repeated submissions while creating the task', async () => {
    const pending = deferred<string | null>();
    mocks.ensureMakeTask.mockReturnValue(pending.promise);
    const view = openDialog();
    fireEvent.change(view.input, { target: { value: 'Add a filter' } });
    fireEvent.click(view.submit);
    fireEvent.submit(view.input.closest('form')!);
    fireEvent.keyDown(view.input, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(mocks.ensureMakeTask).toHaveBeenCalledTimes(1));
    expect(view.submit.disabled).toBe(true);
    expect(view.input.disabled).toBe(true);
    await act(async () => pending.resolve('make-task'));
    expect(mocks.startMakeDoctorInStream).toHaveBeenCalledTimes(1);
    expect(mocks.navigate).toHaveBeenCalledTimes(1);
  });

  it('keeps the requirements after a creation failure and permits retry', async () => {
    mocks.ensureMakeTask.mockRejectedValueOnce(new Error('creation failed'));
    const view = openDialog();
    fireEvent.change(view.input, { target: { value: 'Add a filter' } });
    fireEvent.click(view.submit);
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(view.input.value).toBe('Add a filter');
    expect(view.submit.disabled).toBe(false);
    expect(mocks.startMakeDoctorInStream).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
    fireEvent.click(view.submit);
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledTimes(1));
    expect(mocks.ensureMakeTask).toHaveBeenCalledTimes(2);
  });

  it('reuses the created task if starting the workflow fails', async () => {
    mocks.startMakeDoctorInStream.mockReturnValueOnce(null);
    const view = openDialog();
    fireEvent.change(view.input, { target: { value: 'Add a filter' } });
    fireEvent.click(view.submit);
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    fireEvent.click(view.submit);
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledTimes(1));
    expect(mocks.ensureMakeTask.mock.calls[1][0].sessionId).toBe('make-task');
  });

  it('does not start or navigate under a different account after task creation', async () => {
    const pending = deferred<string | null>();
    mocks.ensureMakeTask.mockReturnValue(pending.promise);
    const view = openDialog();
    fireEvent.change(view.input, { target: { value: 'Add a filter' } });
    fireEvent.click(view.submit);
    await waitFor(() => expect(mocks.ensureMakeTask).toHaveBeenCalledTimes(1));
    setDataOwnerGeneration('owner-b', 2);
    expect(mocks.ensureMakeTask.mock.calls[0][0].isCurrent()).toBe(false);
    await act(async () => pending.resolve('old-owner-task'));
    expect(mocks.startMakeDoctorInStream).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(view.onOpenChange).toHaveBeenCalledWith(false);
  });

  it('dismisses a stale form rather than submitting the previous account’s request', async () => {
    const view = openDialog();
    fireEvent.change(view.input, { target: { value: 'Add a filter' } });
    setDataOwnerGeneration('owner-b', 2);
    await act(async () => fireEvent.click(view.submit));
    expect(mocks.ensureMakeTask).not.toHaveBeenCalled();
    expect(mocks.startMakeDoctorInStream).not.toHaveBeenCalled();
    expect(view.onOpenChange).toHaveBeenCalledWith(false);
  });

  it('keeps accepted work independent of Settings unmount without late navigation', async () => {
    const pending = deferred<string | null>();
    mocks.ensureMakeTask.mockReturnValue(pending.promise);
    const view = openDialog();
    fireEvent.change(view.input, { target: { value: 'Add a filter' } });
    fireEvent.click(view.submit);
    await waitFor(() => expect(mocks.ensureMakeTask).toHaveBeenCalledTimes(1));
    view.unmount();
    expect(mocks.ensureMakeTask.mock.calls[0][0].isCurrent()).toBe(true);
    await act(async () => pending.resolve('make-task'));
    expect(mocks.startMakeDoctorInStream).toHaveBeenCalledExactlyOnceWith('make-task', {
      command: 'cindy-make',
      request: 'Add a filter',
    });
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(view.onOpenChange).not.toHaveBeenCalled();
  });

  it('supports Ctrl+Enter but never submits while composing text', async () => {
    const view = openDialog();
    fireEvent.change(view.input, { target: { value: 'Add a filter' } });
    await act(async () => {
      fireEvent.keyDown(view.input, { key: 'Enter', ctrlKey: true, isComposing: true });
    });
    expect(mocks.ensureMakeTask).not.toHaveBeenCalled();
    fireEvent.keyDown(view.input, { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledTimes(1));
  });
});
