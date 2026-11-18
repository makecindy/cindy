import type { XdtHelperMcpDeps } from '@cindy/mcps';
import type { InvokeResultPayload } from '@cindy/device-link';
import {
  PROJECT_SETTINGS_SET_CHANNEL,
  parseHostProjectAliasesSnapshot,
  resolveProjectDirectories,
  resolveProjectIcon,
  projectAliasComparisonKey,
  parseProjectSymbol,
  parseProjectLetters,
} from '@cindy/maker-shared/project-alias-sync';
import { createProject as createLocalProject } from './createProjectCore.js';
import {
  listProjects as listLocalProjects,
  renameProject as renameLocalProject,
  removeProject as removeLocalProject,
} from './projectManagementCore.js';
import {
  readProjectInfo as readLocalInfo,
  updateProjectInfo as writeLocalInfo,
} from '../projectInfoCore.js';
import { resolveAutomaticProjectIcon as inspectLocalIcon } from '../projectAutomaticIcon.js';
import {
  assertTaskActionCurrent,
  captureTaskActionSyncGuard,
} from '../maker-ipc/taskActionAuthorization.js';
import { isSessionSharedTaskActive } from '../device-link/sharedTaskDispatch.js';

const defaultLocal = {
  createProject: (...args: Parameters<typeof createLocalProject>) => createLocalProject(...args),
  listProjects: (...args: Parameters<typeof listLocalProjects>) => listLocalProjects(...args),
  renameProject: (...args: Parameters<typeof renameLocalProject>) => renameLocalProject(...args),
  removeProject: (...args: Parameters<typeof removeLocalProject>) => removeLocalProject(...args),
  readProjectInfo: (...args: Parameters<typeof readLocalInfo>) => readLocalInfo(...args),
  updateProjectInfo: (...args: Parameters<typeof writeLocalInfo>) => writeLocalInfo(...args),
  resolveAutomaticProjectIcon: (...args: Parameters<typeof inspectLocalIcon>) =>
    inspectLocalIcon(...args),
};
export interface ProjectToolPorts {
  deviceId(): string;
  withAccountDataAccess<T>(
    sessionId: string,
    operation: (assertCurrent: () => Promise<void>) => Promise<T>,
  ): Promise<T>;
  invokeRemote(
    deviceId: string,
    channel: string,
    args: unknown[],
    options?: { preSend?: () => void | Promise<void> },
  ): Promise<InvokeResultPayload>;
  /** Desktop broadcasts and Node Host events wrap the same local operations. */
  local?: Partial<typeof defaultLocal>;
}

/** One project tool implementation for Desktop and Node Host; no Electron dependency. */
export function createProjectToolCallbacks(
  deps: ProjectToolPorts,
): Pick<XdtHelperMcpDeps, 'createProject' | 'projectManagement'> {
  const {
    createProject,
    listProjects,
    renameProject,
    removeProject,
    readProjectInfo,
    updateProjectInfo,
    resolveAutomaticProjectIcon,
  } = { ...defaultLocal, ...deps.local };
  const getDeviceId = () => deps.deviceId();
  const withAccountDataAccess = <T>(
    id: string,
    operation: (assertCurrent: () => Promise<void>) => Promise<T>,
  ) => deps.withAccountDataAccess(id, operation);
  const withProjectWriteAccess = <T>(
    sessionId: string,
    operation: (assertCurrent: () => Promise<void>) => Promise<T>,
  ) =>
    withAccountDataAccess(sessionId, (assertAccess) =>
      operation(async () => {
        await assertTaskActionCurrent();
        await assertAccess();
      }),
    );
  return {
    createProject: async ({ device, ...params }) => {
      await assertTaskActionCurrent();
      if (isSessionSharedTaskActive(params.callerSessionId))
        return {
          ok: false,
          errorCode: 'PERMISSION_DENIED',
          message: 'Not available in a shared task',
        };
      if (!device || device === 'local' || device === getDeviceId())
        return withProjectWriteAccess(params.callerSessionId, async (assertCurrent) => {
          await assertCurrent();
          const result = await createProject(params);
          await assertCurrent();
          return result;
        });
      return withProjectWriteAccess(params.callerSessionId, async (assertCurrent) => {
        const read = await deps.invokeRemote(device, 'sidebar-settings:get-project-aliases', [], {
          preSend: assertCurrent,
        });
        if (!read.ok)
          return { ok: false as const, errorCode: read.error.code, message: read.error.message };
        const snapshot = parseHostProjectAliasesSnapshot(read.result);
        if (
          !snapshot?.ownerStamp ||
          (snapshot.settingsVersion ?? 0) < (params.repositoryUrl || !params.workingDir ? 7 : 6)
        )
          return {
            ok: false as const,
            errorCode: 'UNSUPPORTED_CAPABILITY',
            message: 'Update the selected computer to create this project.',
          };
        const result = await deps.invokeRemote(
          device,
          PROJECT_SETTINGS_SET_CHANNEL,
          [
            {
              ...snapshot.ownerStamp,
              create: true,
              projectKey: `local:${params.workingDir ?? ''}`,
              repositoryUrl: params.repositoryUrl,
              field: 'profile',
              value: {
                ...(params.name !== undefined ? { name: params.name } : {}),
                ...(params.icon !== undefined ? { icon: params.icon } : {}),
                ...(params.directories !== undefined ? { directories: params.directories } : {}),
              },
            },
          ],
          { preSend: assertCurrent },
        );
        await assertCurrent();
        if (!result.ok)
          return {
            ok: false as const,
            errorCode: result.error.code,
            message: result.error.message,
          };
        const created = (result.result as { createdProjectKey?: string })?.createdProjectKey;
        const workingDir = created?.startsWith('local:') ? created.slice(6) : params.workingDir;
        return workingDir
          ? { ok: true as const, workingDir }
          : {
              ok: false as const,
              errorCode: 'INTERNAL',
              message: 'Project creation result unavailable.',
            };
      });
    },
    projectManagement: {
      readInfo: async ({ callerSessionId, device, projectKey }) => {
        if (isSessionSharedTaskActive(callerSessionId))
          return {
            ok: false,
            errorCode: 'PERMISSION_DENIED',
            message: 'Not available in a shared task',
          };
        return withAccountDataAccess(callerSessionId, async (assertCurrent) => {
          const response =
            !device || device === 'local' || device === getDeviceId()
              ? await readProjectInfo()
              : await deps
                  .invokeRemote(device, 'sidebar-settings:get-project-aliases', [], {
                    preSend: assertCurrent,
                  })
                  .then((result) => {
                    if (!result.ok) throw new Error(result.error.message);
                    return result.result;
                  });
          await assertCurrent();
          const snapshot = parseHostProjectAliasesSnapshot(response);
          if (!snapshot)
            return {
              ok: false as const,
              errorCode: 'UNSUPPORTED_CAPABILITY',
              message: 'Project settings unavailable',
            };
          const comparison = projectAliasComparisonKey(projectKey, snapshot.platform);
          return {
            ok: true as const,
            project: {
              project_key: projectKey,
              device: device ?? 'local',
              main_directory: projectKey.startsWith('local:')
                ? projectKey.slice(6)
                : projectKey.startsWith('remote:')
                  ? projectKey.slice(projectKey.indexOf(':', 7) + 1)
                  : null,
              settings_version: snapshot.settingsVersion ?? 0,
              name:
                snapshot.aliases.find(
                  (row) =>
                    projectAliasComparisonKey(row.projectKey, snapshot.platform) === comparison,
                )?.alias ?? null,
              icon: resolveProjectIcon(snapshot, projectKey),
              directories: resolveProjectDirectories(snapshot, projectKey) ?? [],
              directories_supported: (snapshot.settingsVersion ?? 0) >= 6,
            },
          };
        });
      },
      inspectIcon: async ({ callerSessionId, device, projectKey }) => {
        if (isSessionSharedTaskActive(callerSessionId))
          return {
            ok: false,
            errorCode: 'PERMISSION_DENIED',
            message: 'Not available in a shared task',
          };
        return withAccountDataAccess(callerSessionId, async (assertCurrent) => {
          if (!device || device === 'local' || device === getDeviceId()) {
            const icon = await resolveAutomaticProjectIcon({ projectKey });
            await assertCurrent();
            return { ok: true as const, icon };
          }
          const response = await deps.invokeRemote(
            device,
            'sidebar-settings:get-project-auto-icon',
            [{ projectKey }],
            { preSend: assertCurrent },
          );
          await assertCurrent();
          return response.ok
            ? { ok: true as const, icon: response.result }
            : {
                ok: false as const,
                errorCode: 'UNSUPPORTED_CAPABILITY',
                message: response.error.message,
              };
        });
      },
      updateInfo: async ({ callerSessionId, device, ...request }) => {
        await assertTaskActionCurrent();
        if (isSessionSharedTaskActive(callerSessionId))
          return {
            ok: false,
            errorCode: 'PERMISSION_DENIED',
            message: 'Not available in a shared task',
          };
        return withProjectWriteAccess(callerSessionId, async (assertCurrent) => {
          if (!device || device === 'local' || device === getDeviceId()) {
            const snapshot = await readProjectInfo();
            await assertCurrent();
            await updateProjectInfo(
              { ...request, ...snapshot.ownerStamp },
              { kind: 'host', assertCurrent: captureTaskActionSyncGuard() },
            );
          } else {
            const response = await deps.invokeRemote(
              device,
              'sidebar-settings:get-project-aliases',
              [],
              { preSend: assertCurrent },
            );
            await assertCurrent();
            if (!response.ok)
              return {
                ok: false as const,
                errorCode: 'INTERNAL',
                message: response.error.message,
              };
            const snapshot = response.result as {
              settingsSupported?: boolean;
              settingsVersion?: number;
              ownerStamp?: unknown;
            };
            if (
              !snapshot.settingsSupported ||
              (snapshot.settingsVersion ?? 0) < 2 ||
              !snapshot.ownerStamp
            )
              return {
                ok: false as const,
                errorCode: 'UNSUPPORTED_CAPABILITY',
                message: 'Update the target computer and retry.',
              };
            if (
              request.field === 'profile' &&
              request.value &&
              typeof request.value === 'object' &&
              'directories' in request.value &&
              (snapshot.settingsVersion ?? 0) < 6
            )
              return {
                ok: false as const,
                errorCode: 'UNSUPPORTED_CAPABILITY',
                message: 'Update the target computer to configure project directories.',
              };
            const requestedIcon =
              request.field === 'icon'
                ? request.value
                : request.field === 'profile' && request.value && typeof request.value === 'object'
                  ? request.value.icon
                  : null;
            const symbol =
              typeof requestedIcon === 'string' ? parseProjectSymbol(requestedIcon) : null;
            if (symbol && symbol.color !== 'default' && (snapshot.settingsVersion ?? 0) < 3)
              return {
                ok: false as const,
                errorCode: 'UNSUPPORTED_CAPABILITY',
                message: 'Update the target computer to set an icon color.',
              };
            const letters =
              typeof requestedIcon === 'string' ? parseProjectLetters(requestedIcon) : null;
            if (letters && letters.color !== 'default' && (snapshot.settingsVersion ?? 0) < 5)
              return {
                ok: false as const,
                errorCode: 'UNSUPPORTED_CAPABILITY',
                message: 'Update the target computer to set a letter color.',
              };
            const saved = await deps.invokeRemote(
              device,
              'sidebar-settings:set-project-info',
              [{ ...request, ...(snapshot.ownerStamp as object) }],
              { preSend: assertCurrent },
            );
            await assertCurrent();
            if (!saved.ok)
              return { ok: false as const, errorCode: 'INTERNAL', message: saved.error.message };
          }
          return { ok: true as const, saved: true };
        });
      },
      list: async ({ device, ...options }) => {
        if (!device || device === 'local' || device === getDeviceId())
          return withAccountDataAccess(options.callerSessionId, () => listProjects(options));
        if (isSessionSharedTaskActive(options.callerSessionId))
          return {
            ok: false,
            errorCode: 'PERMISSION_DENIED',
            message: 'Not available in a shared task',
          };
        return withAccountDataAccess(options.callerSessionId, async (assertCurrent) => {
          const support = await deps.invokeRemote(
            device,
            'maker:session:handoff',
            [{ action: 'task-action-capability' }],
            { preSend: assertCurrent },
          );
          await assertCurrent();
          if (
            !support.ok ||
            (support.result as { projectCatalogVersion?: unknown } | null)
              ?.projectCatalogVersion !== 1
          )
            return {
              ok: false as const,
              errorCode: 'UNSUPPORTED_CAPABILITY',
              message:
                'The destination must support the remote project catalog. Update it and retry.',
            };
          const { callerSessionId: _caller, ...remoteOptions } = options;
          const response = await deps.invokeRemote(
            device,
            'maker:session:handoff',
            [{ action: 'list-projects', options: remoteOptions }],
            { preSend: assertCurrent },
          );
          await assertCurrent();
          if (!response.ok)
            return { ok: false as const, errorCode: 'INTERNAL', message: response.error.message };
          return response.result as Awaited<ReturnType<typeof listProjects>>;
        });
      },
      rename: (params) =>
        withAccountDataAccess(params.callerSessionId, () => renameProject(params)),
      remove: (params) =>
        withAccountDataAccess(params.callerSessionId, () => removeProject(params)),
    },
  };
}
