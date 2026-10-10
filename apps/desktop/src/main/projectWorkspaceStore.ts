import { BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { z } from 'zod';

import { isDataOwnerPushStamp, type DataOwnerPushStamp } from '../shared/dataOwnerPush.js';
import { isIpcError } from '../shared/ipc-errors.js';
import {
  PROJECT_WORKSPACES_CHANGED_CHANNEL,
  PROJECT_WORKSPACES_GET_CHANNEL,
  PROJECT_WORKSPACES_MUTATE_CHANNEL,
  type ProjectWorkspace,
  type ProjectWorkspaceMutation,
  type ProjectWorkspaceSnapshot,
} from '../shared/projectWorkspaceSettings.js';
import {
  activeOwnerScopeKey,
  getActiveDataOwnerPushStamp,
  isAppSessionBoundaryPending,
  ownerScopedUserDataPath,
} from './appSessionState.js';
import { createLogger } from './logger.js';
import { createOverrideSettingsFile } from './maker-host/override-settings-file.js';
import {
  assertTrustedAppRendererEvent,
  isTrustedAppRendererWindow,
} from './security/trustedAppRenderer.js';
import { throwIpcError } from './utils/ipcValidate.js';
import { readBoundedFileNoFollowSync } from './utils/readBoundedFile.js';

interface ProjectWorkspaceSettings {
  workspaces: ProjectWorkspace[];
}

const idSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => value.trim() === value);
const nameSchema = z.string().trim().min(1).max(80);
const projectKeySchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => value.trim().length > 0 && !value.includes(String.fromCharCode(0)));
const workspaceSchema = z.strictObject({
  id: idSchema,
  name: nameSchema,
  projectKeys: z.array(projectKeySchema).max(10000),
  collapsed: z.boolean(),
});
const settingsSchema = z
  .strictObject({
    workspaces: z.array(workspaceSchema).max(1000).default([]),
  })
  .refine(({ workspaces }) => {
    const ids = workspaces.map((workspace) => workspace.id);
    const names = workspaces.map((workspace) => workspace.name.toLowerCase());
    const projectKeys = workspaces.flatMap((workspace) => workspace.projectKeys);
    return (
      new Set(ids).size === ids.length &&
      new Set(names).size === names.length &&
      new Set(projectKeys).size === projectKeys.length
    );
  });
const requestSchema = z.strictObject({
  ownerStamp: z
    .strictObject({
      dataOwnerId: z.string().min(1).max(4096).nullable(),
      ownerGeneration: z.number().int().nonnegative(),
    })
    .refine(isDataOwnerPushStamp),
  mutation: z.discriminatedUnion('type', [
    z.strictObject({
      type: z.literal('create'),
      id: idSchema,
      name: nameSchema,
      projectKey: projectKeySchema.optional(),
    }),
    z.strictObject({ type: z.literal('rename'), id: idSchema, name: nameSchema }),
    z.strictObject({ type: z.literal('delete'), id: idSchema }),
    z.strictObject({
      type: z.literal('reorder'),
      workspaceIds: z
        .array(idSchema)
        .max(1000)
        .refine((ids) => new Set(ids).size === ids.length),
    }),
    z.strictObject({
      type: z.literal('move-project'),
      projectKey: projectKeySchema,
      workspaceId: idSchema.nullable(),
    }),
    z.strictObject({ type: z.literal('set-collapsed'), id: idSchema, collapsed: z.boolean() }),
  ]),
});
const DEFAULTS: ProjectWorkspaceSettings = { workspaces: [] };
const FILE_NAME = 'project-workspaces.json';
const MAX_BYTES = 1024 * 1024;
const log = createLogger('project-workspaces');
const stores = new Map<
  string,
  ReturnType<typeof createOverrideSettingsFile<ProjectWorkspaceSettings>>
>();

function currentStore() {
  const ownerRoot = ownerScopedUserDataPath();
  let store = stores.get(ownerRoot);
  if (!store) {
    store = createOverrideSettingsFile<ProjectWorkspaceSettings>({
      filePath: () => path.join(ownerRoot, FILE_NAME),
      defaults: DEFAULTS,
      normalize: (raw) => settingsSchema.parse(raw),
      log,
      label: 'project-workspaces',
      scopeKey: activeOwnerScopeKey,
      maxBytes: MAX_BYTES,
      preserveUnreadableFile: true,
      logLoadedValue: false,
      logReadErrorDetails: false,
    });
    stores.set(ownerRoot, store);
  }
  return store;
}

function assertRequestedOwner(request: DataOwnerPushStamp): void {
  const current = getActiveDataOwnerPushStamp();
  if (
    isAppSessionBoundaryPending() ||
    !current.dataOwnerId ||
    current.dataOwnerId !== request.dataOwnerId ||
    current.ownerGeneration !== request.ownerGeneration
  ) {
    throwIpcError(
      'PRECONDITION_FAILED',
      'active account changed during project workspace mutation',
    );
  }
}

function applyMutation(
  workspaces: ProjectWorkspace[],
  mutation: ProjectWorkspaceMutation,
): ProjectWorkspace[] {
  if (mutation.type === 'create' || mutation.type === 'rename') {
    const name = mutation.name.toLowerCase();
    if (
      workspaces.some(
        (workspace) => workspace.id !== mutation.id && workspace.name.toLowerCase() === name,
      )
    ) {
      throwIpcError('ALREADY_EXISTS', 'project workspace name already exists');
    }
  }
  if (mutation.type === 'create') {
    if (workspaces.some((workspace) => workspace.id === mutation.id)) {
      throwIpcError('ALREADY_EXISTS', 'project workspace already exists');
    }
    if (workspaces.length >= 1000) {
      throwIpcError('INVALID_PARAMS', 'too many project workspaces');
    }
    const next =
      mutation.projectKey === undefined
        ? workspaces
        : workspaces.map((workspace) => ({
            ...workspace,
            projectKeys: workspace.projectKeys.filter((key) => key !== mutation.projectKey),
          }));
    return [
      ...next,
      {
        id: mutation.id,
        name: mutation.name,
        projectKeys: mutation.projectKey === undefined ? [] : [mutation.projectKey],
        collapsed: false,
      },
    ];
  }
  if (mutation.type === 'reorder') {
    const byId = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
    if (mutation.workspaceIds.length !== workspaces.length) {
      throwIpcError('INVALID_PARAMS', 'workspace order must contain all current workspaces');
    }
    return mutation.workspaceIds.map((id) => {
      const workspace = byId.get(id);
      if (!workspace) throwIpcError('NOT_FOUND', 'project workspace not found');
      return workspace;
    });
  }
  if (mutation.type === 'move-project') {
    if (
      mutation.workspaceId !== null &&
      !workspaces.some((workspace) => workspace.id === mutation.workspaceId)
    ) {
      throwIpcError('NOT_FOUND', 'project workspace not found');
    }
    return workspaces.map((workspace) => {
      if (
        workspace.id === mutation.workspaceId &&
        workspace.projectKeys.includes(mutation.projectKey)
      ) {
        return workspace;
      }
      const projectKeys = workspace.projectKeys.filter((key) => key !== mutation.projectKey);
      if (workspace.id === mutation.workspaceId) {
        if (projectKeys.length >= 10000)
          throwIpcError('INVALID_PARAMS', 'too many workspace projects');
        projectKeys.push(mutation.projectKey);
      }
      return { ...workspace, projectKeys };
    });
  }
  if (!workspaces.some((workspace) => workspace.id === mutation.id)) {
    throwIpcError('NOT_FOUND', 'project workspace not found');
  }
  if (mutation.type === 'delete')
    return workspaces.filter((workspace) => workspace.id !== mutation.id);
  return workspaces.map((workspace) =>
    workspace.id !== mutation.id
      ? workspace
      : {
          ...workspace,
          ...(mutation.type === 'rename'
            ? { name: mutation.name }
            : { collapsed: mutation.collapsed }),
        },
  );
}

function readSnapshot(): ProjectWorkspaceSnapshot {
  const ownerStamp = getActiveDataOwnerPushStamp();
  if (!ownerStamp.dataOwnerId || isAppSessionBoundaryPending()) return { workspaces: [] };
  try {
    const contents = readBoundedFileNoFollowSync(ownerScopedUserDataPath(FILE_NAME), MAX_BYTES);
    if (contents === null) throwIpcError('INTERNAL', 'failed to read project workspaces');
    const settings = settingsSchema.parse(JSON.parse(contents.toString('utf8')));
    return { workspaces: settings.workspaces, ownerStamp };
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return { workspaces: [], ownerStamp };
    }
    log.warn('project workspace settings could not be read');
    throwIpcError('INTERNAL', 'failed to read project workspaces');
  }
}

async function mutateSnapshot(raw: unknown): Promise<ProjectWorkspaceSnapshot> {
  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) throwIpcError('INVALID_PARAMS', 'invalid project workspace mutation');
  const { ownerStamp, mutation } = parsed.data;
  assertRequestedOwner(ownerStamp);
  const scopeKey = activeOwnerScopeKey();
  let settings: ProjectWorkspaceSettings;
  try {
    settings = await currentStore().updateAtomic((current) => {
      assertRequestedOwner(ownerStamp);
      return { workspaces: applyMutation(current.value.workspaces, mutation) };
    });
    assertRequestedOwner(ownerStamp);
  } catch (error) {
    if (isIpcError(error)) throw error;
    assertRequestedOwner(ownerStamp);
    if (scopeKey !== activeOwnerScopeKey()) {
      throwIpcError(
        'PRECONDITION_FAILED',
        'active account changed during project workspace mutation',
      );
    }
    log.warn('project workspace mutation could not be persisted');
    throwIpcError('INTERNAL', 'failed to persist project workspaces');
  }
  const snapshot: ProjectWorkspaceSnapshot = { workspaces: settings.workspaces, ownerStamp };
  for (const window of BrowserWindow.getAllWindows()) {
    if (!isTrustedAppRendererWindow(window)) continue;
    window.webContents.send(PROJECT_WORKSPACES_CHANGED_CHANNEL, snapshot, ownerStamp);
  }
  return snapshot;
}

export function registerProjectWorkspaceIpc(): void {
  ipcMain.handle(PROJECT_WORKSPACES_GET_CHANNEL, (event, ...args: unknown[]) => {
    assertTrustedAppRendererEvent(event);
    if (args.length > 0)
      throwIpcError('INVALID_PARAMS', 'project workspace GET takes no arguments');
    return readSnapshot();
  });
  ipcMain.handle(
    PROJECT_WORKSPACES_MUTATE_CHANNEL,
    (event, request: unknown, ...args: unknown[]) => {
      assertTrustedAppRendererEvent(event);
      if (args.length > 0)
        throwIpcError('INVALID_PARAMS', 'unexpected project workspace arguments');
      return mutateSnapshot(request);
    },
  );
}
