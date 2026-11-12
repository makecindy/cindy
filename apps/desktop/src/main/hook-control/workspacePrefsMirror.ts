import type {
  HookPrefsPatch,
  HookPrefsView,
  HookWorkspacePrefs,
} from '../../shared/hookControlIpc.js';
import {
  isWorkspacePrefsMirrorCandidateCurrent,
  listWorkspacePrefs,
  markWorkspacePrefMirrored,
  pinWorkspacePrefForMirrorRetry,
  reconcileWorkspacePrefsForMirror,
  type HookPrefsChannel,
} from './workspacePrefsStore.js';

export interface WorkspacePrefsMirrorDeps {
  /** 当前可镜像的绑定集合身份；null 表示没有 live binding。 */
  getLiveBindingKey(channel: HookPrefsChannel): string | null;
  /** multi-team 下只允许向仍处于当前绑定集合的 team 写回。 */
  isMirrorTargetCurrent(channel: HookPrefsChannel, teamId: string | null): boolean;
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

export interface WorkspacePrefsMirror {
  (channel: HookPrefsChannel): Promise<void>;
  /** 账号 owner 切换时失效旧回调，并允许新 owner 立即启动独立 flight。 */
  invalidateOwnerBoundary(): void;
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
): WorkspacePrefsMirror {
  const flights = new Map<HookPrefsChannel, Promise<void>>();
  const triggerGenerations = new Map<HookPrefsChannel, number>();
  let ownerBoundaryGeneration = 0;
  const triggerGeneration = (channel: HookPrefsChannel): number =>
    triggerGenerations.get(channel) ?? 0;
  const ownerBoundaryCurrent = (generation: number): boolean =>
    generation === ownerBoundaryGeneration;

  const run = async (channel: HookPrefsChannel, ownerGeneration: number): Promise<void> => {
    while (true) {
      if (!ownerBoundaryCurrent(ownerGeneration)) return;
      const requestedGeneration = triggerGeneration(channel);
      const bindingKey = deps.getLiveBindingKey(channel);
      let snapshotGeneration: number | null = null;
      try {
        if (bindingKey === null) return;
        snapshotGeneration = deps.getRemoteSnapshotGeneration(channel);
        const remote: HookPrefsView = await deps.getRemotePrefs(channel);
        if (!ownerBoundaryCurrent(ownerGeneration)) return;
        if (
          requestedGeneration !== triggerGeneration(channel) ||
          snapshotGeneration !== deps.getRemoteSnapshotGeneration(channel) ||
          bindingKey !== deps.getLiveBindingKey(channel)
        ) {
          continue;
        }
        if (!remote.bound) return;

        let restart = false;
        const currentPrefs = remote.prefs.filter((row) =>
          deps.isMirrorTargetCurrent(channel, row.teamId ?? null),
        );
        const preservedPrefs = listWorkspacePrefs(channel).filter(
          (row) => !deps.isMirrorTargetCurrent(channel, row.teamId ?? null),
        );
        for (const candidate of reconcileWorkspacePrefsForMirror(channel, [
          ...currentPrefs,
          ...preservedPrefs,
        ])) {
          const teamId = candidate.prefs.teamId ?? null;
          if (
            requestedGeneration !== triggerGeneration(channel) ||
            snapshotGeneration !== deps.getRemoteSnapshotGeneration(channel) ||
            bindingKey !== deps.getLiveBindingKey(channel)
          ) {
            restart = true;
            break;
          }
          if (!deps.isMirrorTargetCurrent(channel, teamId)) continue;
          if (!isWorkspacePrefsMirrorCandidateCurrent(channel, candidate)) continue;
          const row = candidate.prefs;
          await deps.setRemotePrefs(channel, row.workspace, completePatch(row), teamId);
          if (!ownerBoundaryCurrent(ownerGeneration)) return;
          const snapshotChanged =
            snapshotGeneration !== deps.getRemoteSnapshotGeneration(channel);
          if (snapshotChanged) {
            pinWorkspacePrefForMirrorRetry(channel, teamId, row.workspace);
          }
          if (
            requestedGeneration !== triggerGeneration(channel) ||
            snapshotChanged ||
            bindingKey !== deps.getLiveBindingKey(channel)
          ) {
            restart = true;
            break;
          }
          markWorkspacePrefMirrored(channel, teamId, row.workspace, candidate.rev);
        }
        if (
          restart ||
          requestedGeneration !== triggerGeneration(channel) ||
          snapshotGeneration !== deps.getRemoteSnapshotGeneration(channel)
        ) {
          continue;
        }
        deps.onLocalPrefsChanged(channel);
        return;
      } catch (error) {
        if (!ownerBoundaryCurrent(ownerGeneration)) return;
        if (
          requestedGeneration !== triggerGeneration(channel) ||
          (snapshotGeneration !== null &&
            snapshotGeneration !== deps.getRemoteSnapshotGeneration(channel)) ||
          bindingKey !== deps.getLiveBindingKey(channel)
        ) {
          continue;
        }
        deps.onError(channel, error);
        return;
      }
    }
  };

  return Object.assign(
    (channel: HookPrefsChannel): Promise<void> => {
      triggerGenerations.set(channel, triggerGeneration(channel) + 1);
      const current = flights.get(channel);
      if (current) return current;
      const flight = run(channel, ownerBoundaryGeneration).finally(() => {
        if (flights.get(channel) === flight) flights.delete(channel);
      });
      flights.set(channel, flight);
      return flight;
    },
    {
      invalidateOwnerBoundary(): void {
        ownerBoundaryGeneration += 1;
        triggerGenerations.clear();
        flights.clear();
      },
    },
  );
}
