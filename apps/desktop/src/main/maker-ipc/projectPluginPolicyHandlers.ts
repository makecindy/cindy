/**
 * Project-level plugin policy IPC handlers.
 *
 * These handlers only persist the policy used when future agent sessions are
 * created. Runtime lifecycles such as an active Orca team deliberately remain
 * outside this boundary.
 */

import path from 'node:path';

import { normalizeWorkingDirForProjectSettings } from '../../shared/workingDir.js';
import type { PluginRegistry } from '../maker-host/plugins/plugin-registry.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { MAKER_INVOKE } from './channels.js';
import type { IpcHandlerRegistry } from './ipcHandlerRegistry.js';

/** Minimal plugin registry surface required by project policy handlers. */
export type ProjectPluginPolicyRegistry = Pick<
  PluginRegistry,
  'setProjectEnabled' | 'clearProjectEnabled' | 'isEnabled'
>;

/** Host dependencies for project-level plugin policy IPC handlers. */
export interface ProjectPluginPolicyHandlerDeps {
  getPluginRegistry(): ProjectPluginPolicyRegistry;
  assertTrustedSender(event: unknown): void;
  resolveIOSSimulatorProjectWorkingDir(workingDir: string): Promise<string | null>;
  runPolicyMutation?<T>(id: string, mutation: () => Promise<T>): Promise<T>;
  onProjectPolicyChanged?(input: {
    workingDir: string;
    id: string;
    effectiveEnabled: boolean;
  }): void | Promise<void>;
}

export interface MainOwnedProjectSession {
  workDir: string;
  remoteHostId?: string | null;
}

/** Resolve an untrusted Renderer path to the matching Main-owned local project key. */
export function resolveMainOwnedIOSSimulatorProject(
  requestedWorkingDir: string,
  sessions: readonly MainOwnedProjectSession[],
): string | null {
  if (!path.isAbsolute(requestedWorkingDir)) return null;
  const requestedProject = normalizeWorkingDirForProjectSettings(requestedWorkingDir);
  if (!requestedProject) return null;
  for (const session of sessions) {
    if (session.remoteHostId) continue;
    const projectWorkingDir = normalizeWorkingDirForProjectSettings(session.workDir);
    if (projectWorkingDir === requestedProject) return projectWorkingDir;
  }
  return null;
}

/** Register project policy writes without coupling them to active runtimes. */
export function registerProjectPluginPolicyHandlers(
  registry: IpcHandlerRegistry,
  deps: ProjectPluginPolicyHandlerDeps,
): void {
  const runMutation = <T>(id: string, mutation: () => Promise<T>): Promise<T> =>
    deps.runPolicyMutation?.(id, mutation) ?? mutation();
  registry.handle(
    MAKER_INVOKE.PLUGINS_SET_PROJECT_ENABLED,
    async (event, workingDir, id, enabled) => {
      if (
        typeof workingDir !== 'string' ||
        typeof id !== 'string' ||
        typeof enabled !== 'boolean'
      ) {
        throwIpcError(
          'INVALID_PARAMS',
          'workingDir (string) + id (string) + enabled (boolean) required',
        );
      }
      if (id === 'ios-simulator') deps.assertTrustedSender(event);
      const authorizedWorkingDir =
        id === 'ios-simulator'
          ? await deps.resolveIOSSimulatorProjectWorkingDir(workingDir)
          : workingDir;
      if (!authorizedWorkingDir) {
        throwIpcError('PERMISSION_DENIED', 'Project scope is not available for this operation');
      }
      await runMutation(id, async () => {
        const ok = await deps
          .getPluginRegistry()
          .setProjectEnabled(id, authorizedWorkingDir, enabled);
        if (!ok) {
          throwIpcError('PERMISSION_DENIED', `Cannot modify essential plugin: ${id}`);
        }
        await deps.onProjectPolicyChanged?.({
          workingDir: authorizedWorkingDir,
          id,
          effectiveEnabled: enabled,
        });
      });
    },
  );

  registry.handle(MAKER_INVOKE.PLUGINS_CLEAR_PROJECT_ENABLED, async (event, workingDir, id) => {
    if (typeof workingDir !== 'string' || typeof id !== 'string') {
      throwIpcError('INVALID_PARAMS', 'workingDir (string) + id (string) required');
    }
    if (id === 'ios-simulator') deps.assertTrustedSender(event);
    const authorizedWorkingDir =
      id === 'ios-simulator'
        ? await deps.resolveIOSSimulatorProjectWorkingDir(workingDir)
        : workingDir;
    if (!authorizedWorkingDir) {
      throwIpcError('PERMISSION_DENIED', 'Project scope is not available for this operation');
    }
    await runMutation(id, async () => {
      const ok = await deps.getPluginRegistry().clearProjectEnabled(id, authorizedWorkingDir);
      if (!ok) {
        throwIpcError('PERMISSION_DENIED', `Cannot modify essential plugin: ${id}`);
      }
      const effectiveEnabled = deps.getPluginRegistry().isEnabled(id, authorizedWorkingDir);
      await deps.onProjectPolicyChanged?.({
        workingDir: authorizedWorkingDir,
        id,
        effectiveEnabled,
      });
    });
  });
}
