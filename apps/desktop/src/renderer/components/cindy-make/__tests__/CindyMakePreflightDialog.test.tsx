// @vitest-environment jsdom
import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { MAKE_DOCTOR_CHECK_IDS, type MakeDoctorReport } from '../../../../shared/cindyMakeDoctor';
import { CindyMakePreflightDialog } from '../CindyMakePreflightDialog';

const h = vi.hoisted(() => ({
  start: vi.fn(),
  cancel: vi.fn(),
  create: vi.fn(),
  navigate: vi.fn(),
  get: vi.fn(),
  prepend: vi.fn(),
  runtime: vi.fn(),
  remote: false,
  publish: undefined as undefined | ((report: MakeDoctorReport) => void),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: { worktree: string; request: string }) =>
      key === 'cindyMake.code.taskTitle' && values ? `[${values.worktree}] ${values.request}` : key,
  }),
}));
vi.mock('react-router-dom', () => ({ useNavigate: () => h.navigate }));
vi.mock('@/lib/cindyMakeDoctor', () => ({ startMakeDoctor: h.start, cancelMakeDoctor: h.cancel }));
vi.mock('@/lib/makerChatStore', () => ({ makerChatStore: { setSessionRuntime: h.runtime } }));
vi.mock('@/lib/sessionService', () => ({ get: h.get }));
vi.mock('@/lib/sessionsStore', () => ({ sessionsStore: { prependCreated: h.prepend } }));
vi.mock('@/features/device-link/stickySessionOrigin', () => ({
  getStickySessionDeviceId: () => (h.remote ? 'remote' : undefined),
}));

const ready: MakeDoctorReport = {
  runId: 'run',
  mode: 'prepare',
  status: 'completed',
  platform: 'win32',
  arch: 'x64',
  checks: MAKE_DOCTOR_CHECK_IDS.map((id) => ({ id, status: 'passed' })),
  source: { status: 'ready', path: '/source' },
  upstream: { status: 'notFound', items: [] },
};
const continueButton = () => screen.getByRole('button', { name: 'cindyMake.upstream.personal' });
const finishChecks = async () => {
  await waitFor(() => expect(h.publish).toBeTypeOf('function'));
  act(() => h.publish!(ready));
};
function open(sessionId?: string) {
  const close = vi.fn();
  return {
    close,
    ...render(
      <CindyMakePreflightDialog
        request="  Keep my request  "
        sessionId={sessionId}
        createOptions={{ agentKind: 'codex', model: 'selected' }}
        onOpenChange={close}
      />,
    ),
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  h.remote = false;
  h.publish = undefined;
  setDataOwnerGeneration('owner', 1);
  h.start.mockImplementation((publish) => {
    h.publish = publish;
    publish({
      ...ready,
      status: 'running',
      source: undefined,
      upstream: { status: 'pending', items: [] },
    });
    return 'run';
  });
  h.cancel.mockResolvedValue(undefined);
  h.create.mockResolvedValue('code-task');
  h.get.mockResolvedValue({ id: 'code-task' });
  window.electronAPI = { ...window.electronAPI, startCindyMakeTask: h.create };
});
afterEach(() => {
  cleanup();
  setDataOwnerGeneration(null);
});

describe('Make preflight confirmation boundary', () => {
  it('names the created task after the first four characters of its worktree run', async () => {
    open();
    await finishChecks();
    act(() => h.publish!({ ...ready, runId: 'f428ca8b-242b-43c6-b2e5-e54bdd915f62' }));
    fireEvent.click(continueButton());
    await waitFor(() =>
      expect(h.create).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: 'f428ca8b-242b-43c6-b2e5-e54bdd915f62',
          title: '[f428] Keep my request',
        }),
      ),
    );
  });

  it('starts checks once under StrictMode without cancelling them on the rehearsal mount', async () => {
    render(
      <StrictMode>
        <CindyMakePreflightDialog request="Fix scrolling" onOpenChange={vi.fn()} />
      </StrictMode>,
    );
    await waitFor(() => expect(h.start).toHaveBeenCalledOnce());
    expect(h.cancel).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
  });

  it.each([undefined, 'origin'])(
    'does not create or navigate during checks from %s',
    async (sessionId) => {
      open(sessionId);
      expect(screen.getByRole('dialog')).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'cindyMake.upstream.personal' })).toBeNull();
      await finishChecks();
      expect(h.create).not.toHaveBeenCalled();
      expect(h.navigate).not.toHaveBeenCalled();
      fireEvent.click(continueButton());
      await waitFor(() => expect(h.navigate).toHaveBeenCalledWith('/cc-agent/code-task'));
      expect(h.create).toHaveBeenCalledExactlyOnceWith({
        originSessionId: sessionId,
        runId: 'run',
        request: '  Keep my request  ',
        title: '[run] Keep my request',
        createOptions: { agentKind: 'codex', model: 'selected' },
      });
      expect(h.runtime).toHaveBeenCalledWith('code-task', { autoTitleDisabled: true });
    },
  );

  it('closes to wait for upstream without creating a task', async () => {
    const view = open();
    await finishChecks();
    expect(screen.queryByRole('button', { name: 'cindyMake.upstream.wait' })).toBeNull();
    const card = screen.getByRole('region', { name: 'cindyMake.title' });
    expect(within(card).queryByRole('button', { name: 'cindyMake.upstream.personal' })).toBeNull();
    const buttons = screen.getAllByRole('button');
    const cancel = screen.getByRole('button', { name: 'settings.cindyMake.create.cancel' });
    const personal = screen.getByRole('button', { name: 'cindyMake.upstream.personal' });
    expect(buttons.indexOf(cancel)).toBeLessThan(buttons.indexOf(personal));
    fireEvent.click(screen.getByRole('button', { name: 'settings.cindyMake.create.cancel' }));
    expect(view.close).toHaveBeenCalledWith(false);
    expect(h.create).not.toHaveBeenCalled();
  });

  it('cancels unfinished checks when dismissed', async () => {
    const view = open();
    await waitFor(() => expect(h.start).toHaveBeenCalledOnce());
    view.unmount();
    expect(h.cancel).toHaveBeenCalledWith('run', 'prepare');
    expect(h.create).not.toHaveBeenCalled();
  });

  it('keeps failed creation in the dialog and retries the same run', async () => {
    h.create.mockRejectedValueOnce(new Error('failure'));
    open();
    await finishChecks();
    fireEvent.click(continueButton());
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(h.navigate).not.toHaveBeenCalled();
    fireEvent.click(continueButton());
    await waitFor(() => expect(h.navigate).toHaveBeenCalledTimes(1));
    expect(h.create.mock.calls[0][0]).toEqual(h.create.mock.calls[1][0]);
  });

  it('coalesces clicks, blocks dismissal during creation, and ignores late navigation after unmount', async () => {
    let done!: (id: string) => void;
    h.create.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          done = resolve;
        }),
    );
    const view = open();
    await finishChecks();
    fireEvent.click(continueButton());
    fireEvent.click(continueButton());
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(view.close).not.toHaveBeenCalled();
    view.unmount();
    await act(async () => done('code-task'));
    expect(h.prepend).toHaveBeenCalledWith({ id: 'code-task' });
    expect(h.navigate).not.toHaveBeenCalled();
    expect(h.cancel).not.toHaveBeenCalled();
  });

  it.each(['account', 'remote'])(
    'does not create after the %s boundary changes',
    async (boundary) => {
      open();
      await finishChecks();
      if (boundary === 'account') setDataOwnerGeneration('other', 2);
      else h.remote = true;
      fireEvent.click(continueButton());
      expect(h.create).not.toHaveBeenCalled();
    },
  );

  it('ignores an old account result after confirmation', async () => {
    let done!: (id: string) => void;
    h.create.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          done = resolve;
        }),
    );
    open();
    await finishChecks();
    fireEvent.click(continueButton());
    setDataOwnerGeneration('other', 2);
    await act(async () => done('old-task'));
    expect(h.prepend).not.toHaveBeenCalled();
    expect(h.navigate).not.toHaveBeenCalled();
  });
});
