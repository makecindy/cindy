/**
 * /learn on a task running on a plugin engine (docs/plans/acp-plugin-bridge.md, 2026-11-25): the
 * distillation task runs on the same plugin engine and model, never on a built-in engine.
 *
 * Permissions keep the learn safety floor: distillation input can carry third-party hub content, so
 * it never runs with full access. Plugin engines have no "accept edits in the workspace" level; it
 * asks for each action (`default`), or the engine's own new-task default when it has no such level.
 */
import type { Effort, Maker, PermissionMode } from '@cindy/maker-core';

import { PluginEngineUnsupportedError } from '../maker-host/engineKind.js';

/** Same admission as opening a task on that engine (停用、卸载或不可用时明确失败). */
export type LearnPluginEngineAdmission = (target: {
  providerId: string | null;
  model: string;
  effort: string | null;
  permissionMode: string;
}) => { model: string; effort: string; permissionMode: string };

export async function createPluginEngineLearnSession(
  deps: {
    maker: Pick<Maker, 'createSession'>;
    admitPluginEngine: LearnPluginEngineAdmission;
    setSessionProvider: (sessionId: string, providerId: string) => void;
  },
  opts: { id: string; workingDir: string; title: string },
  origin: { model?: string; effort?: string; agentDeviceId?: string },
  providerId: string,
): ReturnType<Maker['createSession']> {
  // An engine on another computer of the same account is admitted there when the task starts
  // (same rule as a new task); this computer only carries its location.
  const engineDeviceId = origin.agentDeviceId?.trim() || undefined;
  const admitted = engineDeviceId
    ? { model: origin.model || 'default', effort: origin.effort ?? '', permissionMode: 'default' }
    : deps.admitPluginEngine({
        providerId,
        model: origin.model || 'default',
        effort: origin.effort ?? null,
        permissionMode: 'default',
      });
  if (admitted.permissionMode === 'bypassPermissions') throw new PluginEngineUnsupportedError('Learn');
  // Before createSession: the runtime reads the task's engine when it starts.
  deps.setSessionProvider(opts.id, providerId);
  return deps.maker.createSession({
    id: opts.id,
    agentKind: 'acp',
    providerId,
    ...(engineDeviceId ? { agentDeviceId: engineDeviceId } : {}),
    workingDir: opts.workingDir,
    model: admitted.model,
    ...(admitted.effort ? { effort: admitted.effort as Effort } : {}),
    fastMode: false,
    permissionMode: admitted.permissionMode as PermissionMode,
    title: opts.title,
  });
}
