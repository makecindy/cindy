import type {
  HookPrefsPatch,
  HookPrefsView,
  HookWorkspacePrefs,
} from '../../shared/hookControlIpc.js';
import {
  isWorkspacePrefsMirrorCandidateCurrent,
  markWorkspacePrefMirrored,
  reconcileWorkspacePrefsForMirror,
  type HookPrefsChannel,
} from './workspacePrefsStore.js';

export interface WorkspacePrefsMirrorDeps {
  isLiveBound(channel: HookPrefsChannel): boolean;
  getRemoteSnapshotGeneration(channel: HookPrefsChannel): number;
  getRemotePrefs(channel: HookPrefsChannel): Promise<HookPrefsView>;
  setRemotePrefs(
    channel: HookPrefsChannel,
    workspace: string,
    patch: HookPrefsPatch,
    teamId: string | null,
  ): Promise<unknown>;
  onLocalPrefsChanged(channel: HookPrefsChannel): void;
  onError(channel: HookPrefsChannel, error: unknown): void;
}

function completePatch(row: HookWorkspacePrefs): HookPrefsPatch {
  return {
    model: row.model,
    effort: row.effort,
    agentKind: row.agentKind,
    permissionMode: row.permissionMode,
  };
}

/**
 * 每个渠道只允许一轮重连镜像在途。server clean 行只落本机；只有仍为当前正本的
 * dirty 行会写回，避免旧 prefs.get 快照覆盖稍后到达的 /model 更新。
 */
export function createWorkspacePrefsMirror(
  deps: WorkspacePrefsMirrorDeps,
): (channel: HookPrefsChannel) => Promise<void> {
  const flights = new Map<HookPrefsChannel, Promise<void>>();
  const triggerGenerations = new Map<HookPrefsChannel, number>();
  const triggerGeneration = (channel: HookPrefsChannel): number =>
    triggerGenerations.get(channel) ?? 0;

  const run = async (channel: HookPrefsChannel): Promise<void> => {
    while (true) {
      const requestedGeneration = triggerGeneration(channel);
      try {
        if (!deps.isLiveBound(channel)) return;
        const snapshotGeneration = deps.getRemoteSnapshotGeneration(channel);
        const remote: HookPrefsView = await deps.getRemotePrefs(channel);
        if (
          requestedGeneration !== triggerGeneration(channel) ||
          snapshotGeneration !== deps.getRemoteSnapshotGeneration(channel)
        ) {
          continue;
        }
        if (!remote.bound) return;

        let restart = false;
        for (const candidate of reconcileWorkspacePrefsForMirror(channel, remote.prefs)) {
          if (requestedGeneration !== triggerGeneration(channel)) {
            restart = true;
            break;
          }
          if (!isWorkspacePrefsMirrorCandidateCurrent(channel, candidate)) continue;
          const row = candidate.prefs;
          await deps.setRemotePrefs(channel, row.workspace, completePatch(row), row.teamId ?? null);
          if (requestedGeneration !== triggerGeneration(channel)) {
            restart = true;
            break;
          }
          markWorkspacePrefMirrored(channel, row.teamId ?? null, row.workspace, candidate.rev);
        }
        if (restart || requestedGeneration !== triggerGeneration(channel)) continue;
        deps.onLocalPrefsChanged(channel);
        return;
      } catch (error) {
        if (requestedGeneration !== triggerGeneration(channel)) continue;
        deps.onError(channel, error);
        return;
      }
    }
  };

  return (channel) => {
    triggerGenerations.set(channel, triggerGeneration(channel) + 1);
    const current = flights.get(channel);
    if (current) return current;
    const flight = run(channel).finally(() => {
      if (flights.get(channel) === flight) flights.delete(channel);
    });
    flights.set(channel, flight);
    return flight;
  };
}
