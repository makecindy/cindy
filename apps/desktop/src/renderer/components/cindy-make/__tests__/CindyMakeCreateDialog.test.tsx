// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CindyMakeCreateDialog } from '../CindyMakeCreateDialog';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';

const mocks = vi.hoisted(() => ({
  ensureMakeTask: vi.fn<typeof import('@/lib/cindyMakeDoctorStream').ensureMakeTask>(),
  startMakeDoctorInStream:
    vi.fn<typeof import('@/lib/cindyMakeDoctorStream').startMakeDoctorInStream>(),
  preflight: vi.fn(),
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
vi.mock('../CindyMakePreflightDialog', () => ({
  CindyMakePreflightDialog: (props: unknown) => {
    mocks.preflight(props);
    return <div data-testid="preflight" />;
  },
}));
vi.mock('@/state/newMakerDraft', () => ({
  getDraft: mocks.getDraft,
  getFastModeForModel: mocks.getFastModeForModel,
}));

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

      await waitFor(() => expect(screen.getByTestId('preflight')).toBeTruthy());
      expect(mocks.preflight).toHaveBeenCalledWith({
        request,
        onOpenChange: view.onOpenChange,
        createOptions: {
          agentKind: vendor,
          model: 'selected-model',
          effort: 'high',
          permissionMode: 'acceptEdits',
          providerId: 'selected-provider',
          fastMode: true,
          planModeEnabled: true,
        },
      });
      expect(mocks.ensureMakeTask).not.toHaveBeenCalled();
      expect(mocks.startMakeDoctorInStream).not.toHaveBeenCalled();
      expect(mocks.navigate).not.toHaveBeenCalled();
      expect(view.onOpenChange).not.toHaveBeenCalled();
      expect(JSON.stringify(draft)).toBe(originalDraft);
    },
  );

  it('coalesces repeated submissions before opening preflight', async () => {
    const view = openDialog();
    fireEvent.change(view.input, { target: { value: 'Add a filter' } });
    fireEvent.click(view.submit);
    fireEvent.submit(view.input.closest('form')!);
    fireEvent.keyDown(view.input, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(screen.getByTestId('preflight')).toBeTruthy());
    expect(mocks.getDraft).toHaveBeenCalledTimes(1);
  });

  it('retains requirements if loading preferences fails and allows retry', async () => {
    mocks.getDraft.mockImplementationOnce(() => {
      throw new Error('unavailable');
    });
    const view = openDialog();
    fireEvent.change(view.input, { target: { value: 'Add a filter' } });
    fireEvent.click(view.submit);
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(view.input.value).toBe('Add a filter');
    fireEvent.click(view.submit);
    await waitFor(() => expect(screen.getByTestId('preflight')).toBeTruthy());
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

  it('does not open preflight if Settings unmounts while loading preferences', async () => {
    const view = openDialog();
    fireEvent.change(view.input, { target: { value: 'Add a filter' } });
    fireEvent.click(view.submit);
    view.unmount();
    await act(async () => {});
    expect(mocks.preflight).not.toHaveBeenCalled();
    expect(mocks.ensureMakeTask).not.toHaveBeenCalled();
  });

  it('supports Ctrl+Enter but never submits while composing text', async () => {
    const view = openDialog();
    fireEvent.change(view.input, { target: { value: 'Add a filter' } });
    await act(async () => {
      fireEvent.keyDown(view.input, { key: 'Enter', ctrlKey: true, isComposing: true });
    });
    expect(mocks.ensureMakeTask).not.toHaveBeenCalled();
    fireEvent.keyDown(view.input, { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(screen.getByTestId('preflight')).toBeTruthy());
  });
});
