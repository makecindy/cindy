// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import type { Session } from '@/lib/ccAgent.types';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { TaskMigrationDialog } from '../TaskMigrationDialog';
const state = vi.hoisted(() => ({
  request: vi.fn(),
  invoke: vi.fn(),
  openLink: vi.fn(),
  merge: vi.fn(),
  dismiss: vi.fn(),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/features/device-link/remoteProjectsStore', () => ({
  remoteProjectsStore: {
    captureSessionRead: () => Object.assign(() => true, { mergeActivity: (row: unknown) => row }),
    mergeDeviceSessions: state.merge,
  },
}));
vi.mock('@/components/ui/select', () => ({
  Select: (props: {
    label: string;
    value: string;
    disabled: boolean;
    options: Array<{ value: string; label: string }>;
    onValueChange(value: string): void;
  }) => (
    <select
      aria-label={props.label}
      value={props.value}
      disabled={props.disabled}
      onChange={(e) => props.onValueChange(e.target.value)}
    >
      <option value="" />
      {props.options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
}));
const source = { id: 'task', title: 'Task', status: 'active', deviceLinkDeviceId: 'A' } as Session;
beforeEach(() => {
  vi.clearAllMocks();
  setDataOwnerGeneration('owner');
  state.request.mockImplementation(async (device: string | null, command: { action: string }) => ({
    supported: true,
    deviceId: device ?? 'local',
    ...(command.action === 'caps' ? { copyEstimate: true, projects: ['B-project'] } : {}),
    ...(command.action === 'estimate' ? { estimate: { fileCount: 3, bytes: 1200 } } : {}),
  }));
  state.openLink.mockResolvedValue(undefined);
  Object.assign(window, {
    electronAPI: {
      deviceLink: {
        taskMigration: state.request,
        invoke: state.invoke,
        openLink: state.openLink,
        listDevices: async () => ({
          devices: ['local', 'A', 'B', 'offline', 'phone'].map((deviceId) => ({
            deviceId,
            name: deviceId,
            online: deviceId !== 'offline',
            remoteControlEnabled: true,
            controlEnabled: true,
            platform: deviceId === 'phone' ? 'ios' : 'darwin',
          })),
        }),
      },
    },
  });
});
afterEach(cleanup);
const mount = () =>
  render(
    <MemoryRouter>
      <TaskMigrationDialog session={source} onDismiss={state.dismiss} />
    </MemoryRouter>,
  );
it('uses the source host for commands and the target host for destination projects, with no duplicate start', async () => {
  mount();
  await screen.findByRole('option', { name: 'B' });
  expect(screen.queryByRole('option', { name: 'A' })).toBeNull();
  expect(screen.queryByRole('option', { name: 'offline' })).toBeNull();
  expect(screen.queryByRole('option', { name: 'phone' })).toBeNull();
  expect(screen.getByRole('option', { name: 'local · settings.devices.thisDevice' })).toBeTruthy();
  fireEvent.change(screen.getByRole('combobox', { name: 'taskMigration.device' }), {
    target: { value: 'B' },
  });
  await screen.findByRole('option', { name: 'B-project' });
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: 'taskMigration.start' }) as HTMLButtonElement).disabled,
    ).toBe(false),
  );
  state.request.mockImplementation(async (device: string | null, command: { action: string }) => {
    if (command.action === 'start') return new Promise(() => {});
    return { supported: true, deviceId: device ?? 'local' };
  });
  const start = screen.getByRole('button', { name: 'taskMigration.start' });
  fireEvent.click(start);
  fireEvent.click(start);
  expect(state.request.mock.calls.filter(([, command]) => command.action === 'start')).toEqual([
    ['A', { action: 'start', sessionId: 'task', targetDeviceId: 'B', targetProject: null }],
  ]);
  expect(screen.queryByRole('button', { name: 'taskMigration.close' })).toBeNull();
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
  expect(state.dismiss).not.toHaveBeenCalled();
  expect(state.request.mock.calls.some(([, command]) => command.action === 'cancel')).toBe(false);
});
it('ends an interrupted transfer through Close without offering retry', async () => {
  state.request.mockImplementation(async (device: string | null, command: { action: string }) => ({
    supported: true,
    deviceId: device ?? 'local',
    ...(command.action === 'status'
      ? {
          stage: 'transferring',
          running: false,
          error: 'MIGRATION_FAILED',
          targetDeviceId: 'B',
          targetSessionId: 'migrated',
        }
      : {}),
  }));
  mount();
  await screen.findByRole('alert');
  expect(screen.getAllByRole('button')).toHaveLength(1);
  const close = screen.getByRole('button', { name: 'taskMigration.close' });
  expect(screen.queryByRole('button', { name: 'taskMigration.cancel' })).toBeNull();
  fireEvent.click(close);
  await waitFor(() =>
    expect(state.request).toHaveBeenCalledWith('A', { action: 'cancel', sessionId: 'task' }),
  );
});
it('loads the completed task from the target computer before navigation and dismisses the dialog', async () => {
  state.request.mockImplementation(async (device: string | null, command: { action: string }) => ({
    supported: true,
    deviceId: device ?? 'local',
    ...(command.action === 'status'
      ? {
          stage: 'complete',
          running: false,
          targetDeviceId: 'B',
          targetSessionId: 'migrated',
        }
      : {}),
  }));
  state.invoke.mockResolvedValue({ id: 'migrated', status: 'active' });
  mount();
  await screen.findByRole('button', { name: 'taskMigration.openTarget' });
  expect(screen.queryByRole('button', { name: 'taskMigration.start' })).toBeNull();
  expect(screen.queryByText('taskMigration.bindingsNotice')).toBeNull();
  expect(screen.getByText('taskMigration.successTitle')).toBeTruthy();
  expect(screen.queryByRole('combobox')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'taskMigration.openTarget' }));
  await waitFor(() => expect(state.dismiss).toHaveBeenCalledOnce());
  expect(state.openLink).toHaveBeenCalledWith('B');
  expect(state.invoke).toHaveBeenCalledWith('B', 'local-db:sessions:get', ['migrated']);
  expect(state.merge).toHaveBeenCalledWith('B', 'B', [{ id: 'migrated', status: 'active' }]);
});

it('confirms the project selected in the menu without asking for a second selection', async () => {
  render(
    <MemoryRouter>
      <TaskMigrationDialog
        session={source}
        onDismiss={state.dismiss}
        destination={{ deviceId: 'B', deviceName: 'Work Mac', project: 'B-project' }}
      />
    </MemoryRouter>,
  );
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: 'taskMigration.start' }) as HTMLButtonElement).disabled,
    ).toBe(false),
  );
  expect(screen.queryByRole('combobox')).toBeNull();
  expect(screen.getByText('taskMigration.title')).toBeTruthy();
  expect(screen.getByText(/B-project/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'taskMigration.start' }));
  await waitFor(() =>
    expect(state.request).toHaveBeenCalledWith('A', {
      action: 'start',
      sessionId: 'task',
      targetDeviceId: 'B',
      targetProject: 'B-project',
    }),
  );
});

it.each(['button', 'escape'])(
  'cancels failed preparation before dismissing via %s',
  async (method) => {
    let finishCancel!: (value: unknown) => void;
    state.request.mockImplementation(async (_device, command) => {
      if (command.action === 'cancel')
        return new Promise((resolve) => {
          finishCancel = resolve;
        });
      return command.action === 'status'
        ? { stage: 'preparing', running: false, error: 'MIGRATION_SOURCE_BUSY' }
        : { deviceId: 'local', projects: [] };
    });
    mount();
    await screen.findByRole('alert');
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.queryByText('taskMigration.background')).toBeNull();
    const close = screen.getByRole('button', { name: 'taskMigration.close' });
    if (method === 'escape') fireEvent.keyDown(close, { key: 'Escape' });
    else fireEvent.click(close);
    await waitFor(() =>
      expect(state.request).toHaveBeenCalledWith('A', { action: 'cancel', sessionId: 'task' }),
    );
    expect(state.dismiss).not.toHaveBeenCalled();
    fireEvent.click(close);
    expect(
      state.request.mock.calls.filter(([, command]) => command.action === 'cancel'),
    ).toHaveLength(1);
    finishCancel({ stage: 'cancelled' });
    await waitFor(() => expect(state.dismiss).toHaveBeenCalledOnce());
  },
);

it('keeps failed cleanup visible and lets Close retry cancellation', async () => {
  let cancellations = 0;
  state.request.mockImplementation(async (_device, command) => {
    if (command.action === 'cancel') {
      if (++cancellations === 1) throw new Error('MIGRATION_FAILED');
      return { stage: 'cancelled' };
    }
    return command.action === 'status'
      ? { stage: 'preparing', running: false, error: 'MIGRATION_SOURCE_BUSY' }
      : { deviceId: 'local', projects: [] };
  });
  mount();
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: 'taskMigration.close' }));
  await screen.findByText('taskMigration.errors.MIGRATION_FAILED');
  expect(state.dismiss).not.toHaveBeenCalled();
  expect(screen.getAllByRole('button')).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'taskMigration.close' }));
  await waitFor(() => expect(state.dismiss).toHaveBeenCalledOnce());
  expect(cancellations).toBe(2);
});

it('keeps transfer progress in the dialog until the target completes, including older hosts', async () => {
  let snapshot: Record<string, unknown> = { stage: 'preparing', running: true };
  state.request.mockImplementation(async (_device, command) =>
    command.action === 'status' ? snapshot : { deviceId: 'local', projects: [] },
  );
  mount();
  await screen.findByRole('progressbar');
  expect(screen.getByRole('progressbar').hasAttribute('aria-valuenow')).toBe(false);
  expect(screen.queryByRole('button', { name: 'taskMigration.close' })).toBeNull();
  // Older hosts do not report cancellable, so only the background option is offered.
  expect(screen.queryByRole('button', { name: 'taskMigration.cancelCopy' })).toBeNull();
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
  expect(state.dismiss).toHaveBeenCalledOnce();
  expect(state.request.mock.calls.some(([, command]) => command.action === 'cancel')).toBe(false);
  snapshot = {
    stage: 'transferring',
    running: true,
    progress: {
      phase: 'sending',
      sentBytes: 25,
      totalBytes: 100,
      bytesPerSecond: 10,
    },
  };
  await waitFor(
    () => expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('25'),
    { timeout: 2500 },
  );
  expect(screen.getByText('taskMigration.transferProgress')).toBeTruthy();
  snapshot = {
    stage: 'transferring',
    running: true,
    progress: {
      phase: 'finishing',
      sentBytes: 100,
      totalBytes: 100,
      bytesPerSecond: 0,
    },
  };
  await screen.findByText('taskMigration.finishing', {}, { timeout: 2500 });
  expect(screen.queryByText('taskMigration.successTitle')).toBeNull();
  snapshot = { stage: 'complete', running: false, targetSessionId: 'copy', targetDeviceId: 'B' };
  await screen.findByText('taskMigration.successTitle', {}, { timeout: 2500 });
  expect(screen.queryByRole('progressbar')).toBeNull();
  expect(screen.queryByRole('button', { name: 'taskMigration.start' })).toBeNull();
  expect(screen.getAllByRole('button')).toHaveLength(2);
});

it('cancels a running copy and closes once the source has stopped it', async () => {
  let snapshot: Record<string, unknown> = {
    stage: 'transferring',
    running: true,
    cancellable: true,
  };
  state.request.mockImplementation(async (_device, command) => {
    if (command.action === 'cancel')
      snapshot = { stage: 'transferring', running: true, cancelling: true };
    return command.action === 'status' || command.action === 'cancel'
      ? snapshot
      : { deviceId: 'local', projects: [] };
  });
  mount();
  fireEvent.click(await screen.findByRole('button', { name: 'taskMigration.cancelCopy' }));
  await waitFor(() =>
    expect(state.request).toHaveBeenCalledWith('A', { action: 'cancel', sessionId: 'task' }),
  );
  await screen.findByText('taskMigration.cancelling');
  expect(screen.queryByRole('button', { name: 'taskMigration.cancelCopy' })).toBeNull();
  expect(state.dismiss).not.toHaveBeenCalled();
  snapshot = { stage: 'cancelled', running: false };
  await waitFor(() => expect(state.dismiss).toHaveBeenCalledOnce(), { timeout: 2500 });
});

it('a new destination selection does not reopen the previous copy success screen', async () => {
  state.request.mockImplementation(async (_device, command) =>
    command.action === 'status'
      ? {
          supported: true,
          deviceId: 'A',
          stage: 'complete',
          targetSessionId: 'old-copy',
          targetDeviceId: 'B',
        }
      : {
          supported: true,
          deviceId: 'B',
          projects: [],
          copyEstimate: true,
          estimate: { fileCount: 1, bytes: 8 },
        },
  );
  render(
    <MemoryRouter>
      <TaskMigrationDialog
        session={source}
        onDismiss={state.dismiss}
        destination={{ deviceId: 'B', deviceName: 'Work Mac', project: 'B-project' }}
      />
    </MemoryRouter>,
  );
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: 'taskMigration.start' }) as HTMLButtonElement).disabled,
    ).toBe(false),
  );
  expect(screen.queryByText('taskMigration.successTitle')).toBeNull();
  expect(screen.queryByRole('button', { name: 'taskMigration.openTarget' })).toBeNull();
});

it('waits for source file inventory before enabling Copy', async () => {
  let finish!: (value: unknown) => void;
  const original = state.request.getMockImplementation()!;
  state.request.mockImplementation((device, command) =>
    command.action === 'estimate'
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : original(device, command),
  );
  render(
    <MemoryRouter>
      <TaskMigrationDialog
        session={source}
        onDismiss={state.dismiss}
        destination={{ deviceId: 'B', deviceName: 'Work Mac', project: null }}
      />
    </MemoryRouter>,
  );
  await screen.findByText('taskMigration.estimating');
  expect(
    (screen.getByRole('button', { name: 'taskMigration.start' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  await waitFor(() => expect(finish).toBeTypeOf('function'));
  finish({ estimate: { fileCount: 100, bytes: 2048 } });
  await screen.findByText('taskMigration.fileSummary');
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: 'taskMigration.start' }) as HTMLButtonElement).disabled,
    ).toBe(false),
  );
  expect(state.request).toHaveBeenCalledWith('A', { action: 'estimate', sessionId: 'task' });
});

it('does not copy when the source does not support inventory', async () => {
  state.request.mockResolvedValue({ supported: true, deviceId: 'A' });
  mount();
  await screen.findByText('taskMigration.estimateFailed');
  expect(
    (screen.getByRole('button', { name: 'taskMigration.start' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(state.request.mock.calls.some(([, c]) => c.action === 'estimate')).toBe(false);
});

it.each([
  ['[PRECONDITION_FAILED] MIGRATION_TIMEOUT', 'taskMigration.estimateTimeout'],
  ['[PRECONDITION_FAILED] MIGRATION_TOO_MANY_FILES', 'taskMigration.estimateTooManyFiles'],
  ['[PRECONDITION_FAILED] MIGRATION_FAILED', 'taskMigration.estimateFailed'],
])('explains why inventory failed (%s) and keeps Copy disabled', async (message, text) => {
  const original = state.request.getMockImplementation()!;
  state.request.mockImplementation((device, command) =>
    command.action === 'estimate' ? Promise.reject(new Error(message)) : original(device, command),
  );
  mount();
  await screen.findByText(text);
  expect(
    (screen.getByRole('button', { name: 'taskMigration.start' }) as HTMLButtonElement).disabled,
  ).toBe(true);
});

it.each(['confirm', 'complete'])(
  'clears recovered status errors on %s without erasing action errors',
  async (stage) => {
    let fail = true;
    const original = state.request.getMockImplementation()!;
    state.request.mockImplementation((device, command) => {
      if (command.action !== 'status') return original(device, command);
      if (fail) return Promise.reject(new Error('MIGRATION_DISCONNECTED'));
      return Promise.resolve(
        stage === 'complete'
          ? { stage: 'complete', running: false, targetSessionId: 'copy', targetDeviceId: 'B' }
          : { supported: true, deviceId: 'A' },
      );
    });
    mount();
    await screen.findByText('taskMigration.errors.MIGRATION_DISCONNECTED');
    fail = false;
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull(), { timeout: 2500 });
    if (stage === 'complete') {
      state.openLink.mockRejectedValueOnce(new Error('MIGRATION_OPEN_FAILED'));
      fireEvent.click(screen.getByRole('button', { name: 'taskMigration.openTarget' }));
      await screen.findByText('taskMigration.errors.MIGRATION_OPEN_FAILED');
      const count = state.request.mock.calls.filter(([, c]) => c.action === 'status').length;
      await waitFor(
        () =>
          expect(
            state.request.mock.calls.filter(([, c]) => c.action === 'status').length,
          ).toBeGreaterThan(count),
        { timeout: 2500 },
      );
      expect(screen.getByText('taskMigration.errors.MIGRATION_OPEN_FAILED')).toBeTruthy();
    } else expect(await screen.findByRole('button', { name: 'taskMigration.start' })).toBeTruthy();
  },
);

it.each(['rejected', 'lost-ack', 'accepted'])(
  'only shows the current copy after a %s start over an old completion',
  async (outcome) => {
    let copyId = 'old-copy';
    const original = state.request.getMockImplementation()!;
    state.request.mockImplementation(async (device, command) => {
      const snapshot = () => ({
        supported: true,
        deviceId: 'A',
        stage: 'complete',
        running: false,
        targetSessionId: copyId,
        targetDeviceId: 'B',
      });
      if (command.action === 'status') return snapshot();
      if (command.action === 'start') {
        if (outcome !== 'rejected') copyId = 'new-copy';
        if (outcome !== 'accepted') throw new Error('MIGRATION_START_FAILED');
        return snapshot();
      }
      return original(device, command);
    });
    render(
      <MemoryRouter>
        <TaskMigrationDialog
          session={source}
          onDismiss={state.dismiss}
          destination={{ deviceId: 'B', deviceName: 'Work Mac', project: null }}
        />
      </MemoryRouter>,
    );
    const start = await screen.findByRole('button', { name: 'taskMigration.start' });
    await waitFor(() => expect((start as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(start);
    if (outcome !== 'accepted')
      await screen.findByText('taskMigration.errors.MIGRATION_START_FAILED');
    const polls = state.request.mock.calls.filter(([, c]) => c.action === 'status').length;
    await waitFor(
      () =>
        expect(
          state.request.mock.calls.filter(([, c]) => c.action === 'status').length,
        ).toBeGreaterThan(polls),
      { timeout: 2500 },
    );
    if (outcome === 'rejected') {
      expect(screen.getByText('taskMigration.failureTitle')).toBeTruthy();
      expect(screen.queryByText('taskMigration.successTitle')).toBeNull();
      expect(screen.queryByRole('button', { name: 'taskMigration.openTarget' })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'taskMigration.close' }));
      expect(state.request.mock.calls.some(([, c]) => c.action === 'cancel')).toBe(false);
    } else {
      expect(await screen.findByText('taskMigration.successTitle')).toBeTruthy();
      expect(screen.queryByRole('alert')).toBeNull();
      state.invoke.mockResolvedValue({ id: 'new-copy', status: 'active' });
      fireEvent.click(screen.getByRole('button', { name: 'taskMigration.openTarget' }));
      await waitFor(() =>
        expect(state.invoke).toHaveBeenCalledWith('B', 'local-db:sessions:get', ['new-copy']),
      );
    }
  },
);
it('ignores clicks outside and only closes through Cancel or Escape', async () => {
  mount();
  await screen.findByRole('option', { name: 'B' });
  const dialog = screen.getByRole('dialog');
  // Dialog defers dismissal until the click following a primary pointer press.
  fireEvent.pointerDown(document.body, { button: 0, pointerType: 'mouse' });
  fireEvent.pointerUp(document.body, { button: 0, pointerType: 'mouse' });
  fireEvent.click(document.body);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(screen.getByRole('dialog')).toBe(dialog);
  expect(state.dismiss).not.toHaveBeenCalled();
  fireEvent.keyDown(dialog, { key: 'Escape' });
  await waitFor(() => expect(state.dismiss).toHaveBeenCalledOnce());
});
