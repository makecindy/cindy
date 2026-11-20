// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';
import { __resetStickySessionOriginForTest } from '@/features/device-link/stickySessionOrigin';
import { resetPluginEnginesStoreForTests } from '@/hooks/usePluginEngines';
import type { WorkerInfo } from '../hooks/useWorkers';
import { RolePillDropdown, WorkerListToolbar } from '../RolePillDropdown';

const confirm = vi.hoisted(() => vi.fn(async (_opts: { description: string }) => false));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => {} },
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/hooks/useAppShortcut', () => ({
  useAppShortcutDisplay: () => '',
}));

vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm }),
}));

function worker(overrides: Partial<WorkerInfo> = {}): WorkerInfo {
  return {
    workerId: 'worker-a',
    sessionId: 'proxy-a',
    role: 'transcriber',
    agent: 'claude-code',
    model: 'claude-opus-5-5',
    effort: 'high',
    label: null,
    status: 'running',
    focused: true,
    idleSince: null,
    reportState: null,
    ...overrides,
  };
}

function openMenu(current: WorkerInfo) {
  render(
    <RolePillDropdown
      worker={current}
      workers={[current]}
      selectedWorkerId={current.workerId}
      activeWorkerCount={1}
      onSwitchFocus={vi.fn()}
      onArchiveWorker={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: /transcriber/ }));
}

describe('RolePillDropdown worker on another computer', () => {
  afterEach(() => {
    cleanup();
  });

  it('names the execution device before the model', () => {
    openMenu(
      worker({
        executionDevice: {
          deviceId: 'mac-mini',
          remoteSessionId: 'remote-a',
          deviceName: 'Mac mini',
          reachable: true,
          workingDir: null,
        },
      }),
    );
    expect(screen.getAllByText('Mac mini').length).toBeGreaterThan(0);
    expect(screen.getAllByText('claude-opus-5-5').length).toBeGreaterThan(0);
    expect(screen.queryByText('orca.rolePill.deviceUnreachable')).toBeNull();
  });

  it('shows that status is unavailable instead of the model while unreachable', () => {
    openMenu(
      worker({
        executionDevice: {
          deviceId: 'mac-mini',
          remoteSessionId: 'remote-a',
          deviceName: null,
          reachable: false,
          workingDir: null,
        },
      }),
    );
    expect(screen.getAllByText('orca.rolePill.unknownDevice').length).toBeGreaterThan(0);
    expect(screen.getAllByText('orca.rolePill.deviceUnreachable').length).toBeGreaterThan(0);
  });

  it('explains that archiving keeps the task on the execution device', async () => {
    openMenu(
      worker({
        executionDevice: {
          deviceId: 'mac-mini',
          remoteSessionId: 'remote-a',
          deviceName: 'Mac mini',
          reachable: true,
          workingDir: null,
        },
      }),
    );
    fireEvent.click(screen.getAllByRole('button', { name: 'orca.rolePill.archiveWorkerAria' })[0]!);
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(confirm.mock.calls.at(-1)![0].description).toBe(
      'orca.rolePill.archiveRemoteWorkerConfirmDesc',
    );
  });

  it('leaves local workers unchanged', () => {
    openMenu(worker());
    expect(screen.queryByText('orca.rolePill.unknownDevice')).toBeNull();
    expect(screen.getAllByText('claude-opus-5-5').length).toBeGreaterThan(0);
  });
});

// Guard: actual remote session origin + execution-device projection must prevent local
// project reads/badges. Existing device-name tests did not install a projectLabel endpoint.
describe('Worker project badge device boundary', () => {
  afterEach(() => {
    cleanup();
    remoteProjectsStore.__resetPinnedOriginsForTest();
    __resetStickySessionOriginForTest();
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });
  it.each(['controlled-lead', 'execution-device', 'local'])(
    'only queries and displays the local project for %s',
    async (location) => {
      const projectLabel = vi
        .fn()
        .mockResolvedValue({ name: 'other-project', path: '/other-project' });
      (window as unknown as { electronAPI: unknown }).electronAPI = {
        localDb: { orcaWorkflows: { projectLabel } },
      };
      const current = worker(
        location === 'execution-device'
          ? {
              executionDevice: {
                deviceId: 'execution-pc',
                remoteSessionId: 'remote-worker',
                deviceName: 'Execution PC',
                reachable: true,
                workingDir: '/remote-project',
              },
            }
          : {},
      );
      if (location === 'controlled-lead') {
        remoteProjectsStore.pinSessionOrigin('controlled-pc', 'lead');
        remoteProjectsStore.pinSessionOrigin('controlled-pc', current.sessionId);
      }
      openMenu(current);
      await act(async () => {});
      if (location === 'local') {
        expect(projectLabel).toHaveBeenCalledWith(current.sessionId);
        expect(screen.getAllByText('other-project').length).toBeGreaterThan(0);
      } else {
        expect(projectLabel).not.toHaveBeenCalled();
        expect(screen.queryByText('other-project')).toBeNull();
        expect(screen.getAllByText('claude-opus-5-5').length).toBeGreaterThan(0);
      }
    },
  );

  // PR #11591 review：插件引擎 Worker 跑在 Lead 所在电脑。生产入口 WorkerListToolbar(经 OrcaWorkerPanel)；
  // 缺口：Device Link 控制端此前读本机引擎目录，本机装了同名插件时画成本机的图标。
  // 最小失败输入：被控电脑与本机的同名引擎图标不同。unit/jsdom。
  it('draws a plugin engine Worker with the icon from the Lead computer under Device Link', async () => {
    const REMOTE_ICON = 'data:image/png;base64,UkVNT1RF';
    const engines = (iconDataUrl: string) => [{
      key: 'dsh-acp:dsh', providerId: 'acp-plugin:dsh-acp:dsh', ghostId: 'dsh-acp', harnessId: 'dsh', name: 'DSH',
      availability: { state: 'available' }, models: [], iconDataUrl,
    }];
    const invoke = vi.fn(async () => engines(REMOTE_ICON));
    const listPluginEngines = vi.fn(async () => engines('data:image/png;base64,TE9DQUw='));
    const host = window as unknown as { electronAPI?: unknown };
    host.electronAPI = {
      deviceLink: { invoke },
      maker: { listPluginEngines, onPluginEnginesChanged: () => () => {} },
    };
    onTestFinished(() => {
      delete host.electronAPI;
      resetPluginEnginesStoreForTests();
    });
    const current = worker({ agent: 'acp', providerId: 'acp-plugin:dsh-acp:dsh' });
    render(
      <WorkerListToolbar
        worker={current}
        workers={[current]}
        selectedWorkerId={current.workerId}
        activeWorkerCount={1}
        softLimit={4}
        hardLimit={8}
        onSwitchFocus={vi.fn()}
        onOpenCreate={vi.fn()}
        onArchiveWorker={vi.fn()}
        pluginEngineDeviceId="controlled-pc"
      />,
    );
    await waitFor(() => {
      const icons = [...document.querySelectorAll('[data-plugin-icon]')];
      expect(icons.length).toBeGreaterThan(0);
      expect(icons.map((icon) => icon.getAttribute('src'))).toEqual(icons.map(() => REMOTE_ICON));
    });
    expect(invoke).toHaveBeenCalledWith('controlled-pc', 'maker:list-plugin-engines', []);
    expect(listPluginEngines).not.toHaveBeenCalled();
  });
});
