/**
 * /learn on a plugin engine task (docs/plans/acp-plugin-bridge.md, user decision 2026-11-25): the
 * distillation task runs on the same plugin engine, admitted like any new task on it (turned off,
 * uninstalled, unavailable or a closed model fails this /learn), and never on a built-in engine the
 * user did not pick. Its permissions stay at acceptEdits, as for the built-in engines.
 */

import type { CreateSessionOptions, Effort, SessionMeta } from '@cindy/maker-core';

import type { PluginEngineView } from '../../shared/pluginEngines.js';
import { PluginEngineUnsupportedError } from '../maker-host/engineKind.js';
import { admitPluginEngineSwitchTarget } from '../maker-ipc/pluginEngineSessionAdmission.js';

export function pluginEngineLearnSessionOptions(input: {
  id: string;
  workingDir: string;
  title?: string;
  origin: Pick<SessionMeta, 'model' | 'effort' | 'providerId' | 'agentDeviceId'>;
  /** The origin's provider as the live store has it (the user may have just switched). */
  inheritedProviderId: string | null;
  engines: readonly PluginEngineView[];
}): CreateSessionOptions & { providerId: string | null } {
  // An engine on another computer admits each task there; this computer's catalog cannot stand in.
  if (input.origin.agentDeviceId) throw new PluginEngineUnsupportedError('Learn on another computer');
  const providerId = input.inheritedProviderId ?? input.origin.providerId ?? null;
  const admitted = admitPluginEngineSwitchTarget(
    { providerId, model: input.origin.model ?? '', effort: input.origin.effort ?? null },
    input.engines,
  );
  return {
    id: input.id,
    agentKind: 'acp',
    providerId,
    workingDir: input.workingDir,
    model: admitted.model,
    ...(admitted.effort ? { effort: admitted.effort as Effort } : {}),
    // Learn input can carry third-party hub content: never above the workspace-edit level.
    permissionMode: 'acceptEdits',
    ...(input.title ? { title: input.title } : {}),
  };
}
