import fs from 'node:fs';
import ts from 'typescript';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { isDataOwnerPushStamp } from '../../shared/dataOwnerPush';
import {
  PROJECT_WORKSPACES_GET_CHANNEL,
  PROJECT_WORKSPACES_MUTATE_CHANNEL,
  PROJECT_WORKSPACES_CHANGED_CHANNEL,
  type ProjectWorkspaceMutationRequest,
  type ProjectWorkspaceSnapshot,
} from '../../shared/projectWorkspaceSettings';

type WorkspaceBridge = Pick<
  Window['electronAPI']['sidebarSettings'],
  'getProjectWorkspaces' | 'mutateProjectWorkspaces' | 'onProjectWorkspacesChanged'
>;
type IpcListener = (event: unknown, snapshot: unknown, ownerStamp: unknown) => void;

const source = fs.readFileSync(new URL('../preload.ts', import.meta.url), 'utf8');
const start = source.indexOf('    getProjectWorkspaces:');
const end = source.indexOf('    claimLegacyRendererOwner:', start);
const compiled = ts.transpileModule('return ({' + source.slice(start, end) + '});', {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

const ipc = {
  invoke:
    vi.fn<
      (
        channel: string,
        request?: ProjectWorkspaceMutationRequest,
      ) => Promise<ProjectWorkspaceSnapshot>
    >(),
  on: vi.fn<(channel: string, listener: IpcListener) => void>(),
  removeListener: vi.fn<(channel: string, listener: IpcListener) => void>(),
};
const stamp = { dataOwnerId: 'owner-a', ownerGeneration: 1 };
const snapshot: ProjectWorkspaceSnapshot = { workspaces: [], ownerStamp: stamp };

const createBridge = new Function(
  'ipcRenderer',
  'PROJECT_WORKSPACES_GET_CHANNEL',
  'PROJECT_WORKSPACES_MUTATE_CHANNEL',
  'PROJECT_WORKSPACES_CHANGED_CHANNEL',
  'isDataOwnerPushStamp',
  compiled,
) as (
  ipcRenderer: typeof ipc,
  getChannel: string,
  mutateChannel: string,
  changedChannel: string,
  validateStamp: typeof isDataOwnerPushStamp,
) => WorkspaceBridge;
const bridge = createBridge(
  ipc,
  PROJECT_WORKSPACES_GET_CHANNEL,
  PROJECT_WORKSPACES_MUTATE_CHANNEL,
  PROJECT_WORKSPACES_CHANGED_CHANNEL,
  isDataOwnerPushStamp,
);

beforeEach(() => {
  ipc.invoke.mockReset().mockResolvedValue(snapshot);
  ipc.on.mockClear();
  ipc.removeListener.mockClear();
});

describe('project workspaces preload bridge', () => {
  it('uses fixed IPC channels and preserves the owner-stamped mutation request', async () => {
    expect(await bridge.getProjectWorkspaces()).toEqual(snapshot);
    expect(ipc.invoke).toHaveBeenCalledWith(PROJECT_WORKSPACES_GET_CHANNEL);
    const request: ProjectWorkspaceMutationRequest = {
      ownerStamp: stamp,
      mutation: {
        type: 'create',
        id: 'workspace',
        name: 'Workspace',
        projectKey: 'local:/project',
      },
    };
    expect(await bridge.mutateProjectWorkspaces(request)).toEqual(snapshot);
    expect(ipc.invoke).toHaveBeenCalledWith(PROJECT_WORKSPACES_MUTATE_CHANNEL, request);
    ipc.invoke.mockRejectedValueOnce(new Error('SAVE_FAILED'));
    await expect(bridge.mutateProjectWorkspaces(request)).rejects.toThrow('SAVE_FAILED');
  });

  it('strips Electron events and unregisters the exact listener', () => {
    const callback = vi.fn();
    const unsubscribe = bridge.onProjectWorkspacesChanged(callback);
    const [channel, listener] = ipc.on.mock.calls[0];
    expect(channel).toBe(PROJECT_WORKSPACES_CHANGED_CHANNEL);
    listener({ sender: 'privileged object' }, { workspaces: [] }, stamp);
    expect(callback.mock.calls).toEqual([[snapshot, stamp]]);
    unsubscribe();
    expect(ipc.removeListener).toHaveBeenCalledWith(PROJECT_WORKSPACES_CHANGED_CHANNEL, listener);
  });

  it('rejects unstamped, malformed and conflicting-owner pushes', () => {
    const callback = vi.fn();
    bridge.onProjectWorkspacesChanged(callback);
    const listener = ipc.on.mock.calls[0][1];
    listener({}, snapshot, undefined);
    listener({}, snapshot, { ...stamp, ownerGeneration: -1 });
    listener({}, snapshot, { ...stamp, dataOwnerId: 'owner-b' });
    listener({}, null, stamp);
    listener({}, { workspaces: null }, stamp);
    expect(callback).not.toHaveBeenCalled();
  });
});
