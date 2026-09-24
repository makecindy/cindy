// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StartRemoteSessionPanel } from '@/components/settings/RemoteHostDetail';
import { AddRemoteProjectDialog } from '@/components/new-chat/AddRemoteProjectDialog';
import { SshModelSelectionError } from '@/features/cc-agent/sshSessionModelSelection';
import {
  sshModel,
  sshProvider,
  sshNativeCodexProvider,
} from '@/features/cc-agent/__tests__/sshModelFixtures';
import {
  beginProvidersRefresh,
  commitProvidersSnapshot,
  failProvidersRefresh,
  invalidateProvidersSnapshot,
} from '@/lib/providersSnapshotStore';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  navigate: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
  confirm: vi.fn(),
  stat: vi.fn(),
  mkdir: vi.fn(),
  prefs: vi.fn(),
  listModels: vi.fn(),
  devices: [],
  sessions: [
    { remoteHostId: 'remote-mac', workspaceKind: 'project', workingDir: '/Users/test/project' },
  ],
}));
vi.mock('@/hooks/useControllableDevices', () => ({ useControllableDevices: () => mocks.devices }));
vi.mock('@/hooks/useCCSessions', () => ({ useCCSessions: () => ({ sessions: mocks.sessions }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('react-router-dom', () => ({ useNavigate: () => mocks.navigate }));
vi.mock('@/lib/toast', () => ({ toast: { error: mocks.error, success: mocks.success } }));
vi.mock('@/lib/sessionService', () => ({ create: mocks.create }));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: mocks.confirm }),
}));
vi.mock('@/state/newMakerDraft', () => ({
  getDraft: () => ({ lastByVendor: { codex: mocks.prefs() } }),
  getFastModeForModel: () => true,
}));
vi.mock('@/state/providerModelMemory', () => ({
  getProviderModelEffort: () => undefined,
  getProviderModelFast: () => undefined,
}));

function publish(models = [sshModel('available-model')]) {
  mocks.listModels.mockResolvedValue([sshNativeCodexProvider(models)]);
}
function start() {
  render(<StartRemoteSessionPanel hostId="remote-mac" />);
  fireEvent.click(screen.getByRole('button', { name: 'settings.remote.startSession.start' }));
}

beforeEach(() => {
  vi.clearAllMocks();
  setDataOwnerGeneration('owner', 1);
  invalidateProvidersSnapshot();
  mocks.listModels.mockReset();
  publish();
  mocks.prefs.mockReturnValue({ model: 'gpt-5.5-codex', providerId: null, effort: 'medium' });
  mocks.create.mockResolvedValue({ id: 'new-task' });
  // These are remote POSIX paths, independent of the Windows controller.
  mocks.stat.mockResolvedValue({ kind: 'dir', resolvedPath: '/Users/test/project' });
  mocks.mkdir.mockResolvedValue({ resolvedPath: '/Users/test/project' });
  mocks.confirm.mockResolvedValue(true);
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      remoteSsh: {
        listCodexModels: mocks.listModels,
        statRemotePath: mocks.stat,
        mkdirPRemote: mocks.mkdir,
        list: async () => ({
          hosts: [
            {
              status: 'ready',
              config: { id: 'remote-mac', user: 'test', hostname: 'example.test' },
            },
          ],
        }),
      },
    },
  });
});

describe('ordinary SSH creation error presentation', () => {
  it.each([
    ['no-route', 'noCompatibleModel'],
    ['unsupported-codex-source', 'unsupportedCodexSource'],
    ['catalog-loading', 'modelCatalogLoading'],
    ['catalog-error', 'modelCatalogFailed'],
  ] as const)('preserves the %s reason through the project dialog', async (reason, key) => {
    const onOpenChange = vi.fn();
    const onProjectAdded = vi.fn().mockRejectedValue(new SshModelSelectionError(reason));
    render(
      <AddRemoteProjectDialog open onOpenChange={onOpenChange} onProjectAdded={onProjectAdded} />,
    );
    fireEvent.doubleClick(await screen.findByTitle('/Users/test/project'));
    await waitFor(() =>
      expect(mocks.error).toHaveBeenCalledWith('settings.remote.startSession.' + key),
    );
    expect(mocks.error).toHaveBeenCalledTimes(1);
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
afterEach(cleanup);

describe('settings remote Codex creation', () => {
  it.each(['xd', 'custom-responses', 'openai-second'])(
    'uses the remote default instead of forwarding the saved local %s route',
    async (providerId) => {
      mocks.prefs.mockReturnValue({ model: 'available-model', providerId, effort: 'low' });
      start();
      await waitFor(() => expect(mocks.create).toHaveBeenCalled());
      expect(mocks.listModels).toHaveBeenCalledWith('remote-mac');
      expect(mocks.create.mock.calls[0][0]).toMatchObject({ model: 'available-model', providerId: 'openai' });
      expect(mocks.error).not.toHaveBeenCalled();
    },
  );

  it('uses the remote native catalog even when the controller has only a gateway', async () => {
    commitProvidersSnapshot(beginProvidersRefresh(), {
      dataOwnerId: 'owner',
      ownerGeneration: 1,
      providerOrder: ['xd'],
      providers: [sshProvider('xd', [sshModel('codex/gpt-5.6-luna')])],
    });
    start();
    await waitFor(() => expect(mocks.create).toHaveBeenCalled());
    expect(mocks.create.mock.calls[0][0]).toMatchObject({ model: 'available-model', providerId: 'openai' });
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it('creates with a catalog model, pinned provider and calibrated tuning', async () => {
    start();
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith('/cc-agent/new-task'));
    expect(mocks.create).toHaveBeenCalledExactlyOnceWith({
      agentKind: 'codex',
      workingDir: '/Users/test/project',
      workspaceKind: 'project',
      permissionMode: 'auto',
      model: 'available-model',
      providerId: 'openai',
      effort: 'high',
      fastMode: false,
      remoteHostId: 'remote-mac',
    });
  });

  it('uses remote defaults even when the local native preference is available remotely', async () => {
    publish([sshModel('first', { supportsFastMode: true }), sshModel('chosen', { supportsFastMode: true })]);
    mocks.prefs.mockReturnValue({ model: 'chosen', providerId: 'openai', effort: 'low' });
    start();
    await waitFor(() => expect(mocks.create).toHaveBeenCalled());
    expect(mocks.create.mock.calls[0][0]).toMatchObject({
      model: 'first',
      providerId: 'openai',
      effort: 'high',
      fastMode: false,
    });
    expect(mocks.prefs).not.toHaveBeenCalled();
  });

  it.each(['failed', 'empty', 'bridge'] as const)(
    'blocks %s remote catalogs before directory or database changes',
    async (state) => {
      if (state === 'failed') mocks.listModels.mockRejectedValue(new Error('offline'));
      if (state === 'empty') publish([]);
      if (state === 'bridge') publish([sshModel('chatgpt/local-only')]);
      start();
      const suffix =
        state === 'failed'
            ? 'modelCatalogFailed'
            : 'noCompatibleModel';
      await waitFor(() =>
        expect(mocks.error).toHaveBeenCalledWith('settings.remote.startSession.' + suffix),
      );
      expect(mocks.stat).not.toHaveBeenCalled();
      expect(mocks.mkdir).not.toHaveBeenCalled();
      expect(mocks.create).not.toHaveBeenCalled();
      expect(mocks.navigate).not.toHaveBeenCalled();
    },
  );

  it.each(['loading', 'failed'] as const)('ignores a %s controller catalog', async (state) => {
    if (state === 'loading') invalidateProvidersSnapshot();
    else failProvidersRefresh(beginProvidersRefresh());
    start();
    await waitFor(() => expect(mocks.create).toHaveBeenCalled());
    expect(mocks.create.mock.calls[0][0].model).toBe('available-model');
  });

  it('waits for remote discovery before touching directories or creating a task', async () => {
    let finish!: (value: ReturnType<typeof sshNativeCodexProvider>[]) => void;
    mocks.listModels.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    start();
    await waitFor(() => expect(mocks.listModels).toHaveBeenCalled());
    expect(mocks.stat).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
    expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => finish([sshNativeCodexProvider([sshModel('available-model')])]));
    await waitFor(() => expect(mocks.create).toHaveBeenCalled());
  });

  it('rechecks model availability after waiting for the remote directory', async () => {
    mocks.stat.mockImplementation(async () => {
      publish([]);
      return { kind: 'dir', resolvedPath: '/Users/test/project' };
    });
    start();
    await waitFor(() =>
      expect(mocks.error).toHaveBeenCalledWith('settings.remote.startSession.noCompatibleModel'),
    );
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('uses a new valid catalog route if the catalog changes during validation', async () => {
    mocks.stat.mockImplementation(async () => {
      publish([sshModel('new-catalog-model')]);
      return { kind: 'dir', resolvedPath: '/Users/test/project' };
    });
    start();
    await waitFor(() => expect(mocks.create).toHaveBeenCalled());
    expect(mocks.create.mock.calls[0][0]).toMatchObject({
      model: 'new-catalog-model',
      providerId: 'openai',
    });
  });

  it('does not create after the account changes during directory validation', async () => {
    mocks.stat.mockImplementation(async () => {
      setDataOwnerGeneration('another-owner', 2);
      return { kind: 'dir', resolvedPath: '/Users/test/project' };
    });
    start();
    await waitFor(() =>
      expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(false),
    );
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('still respects cancellation when the remote directory is missing', async () => {
    mocks.stat.mockResolvedValue({ kind: 'missing', resolvedPath: '/Users/test/project' });
    mocks.confirm.mockResolvedValue(false);
    start();
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalled());
    expect(mocks.mkdir).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
