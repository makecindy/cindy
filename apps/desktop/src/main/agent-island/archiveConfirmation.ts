import { dialog } from 'electron';
import type { Schedule } from '@cindy/maker-scheduler';
import { t } from '../i18n.desktop.js';
import { remoteInvoke } from '../device-link/index.js';
import { listWorkersByLead } from '../localDb/orcaTeamStore.js';
import { getRemovalPreview } from '../worktree/WorktreeManager.js';
import { getScheduleStorageIfInitialized } from '../scheduler-host/index.desktop.js';

function withBudget<T>(promise: Promise<T>, fallback: T, ms = 1500): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise.catch(() => fallback),
    new Promise<T>((resolve) => {
      timeout = setTimeout(() => resolve(fallback), ms);
    }),
  ]).finally(() => clearTimeout(timeout));
}

async function listRemoteBindings(deviceId: string): Promise<Schedule[]> {
  const result = await remoteInvoke(deviceId, 'maker:schedule:list', [null, { sessionBindings: true }]);
  return result.ok && Array.isArray(result.result) ? (result.result as Schedule[]) : [];
}

/** Match desktop archive preflights, with the confirmation on the initiating computer. */
export async function confirmIslandArchive(sessionId: string, deviceId: string | null): Promise<boolean> {
  const preview = (async () => {
    if (deviceId) {
      const result = await remoteInvoke(deviceId, 'worktree:removal-preview', [sessionId]);
      if (!result.ok) throw new Error(result.error.message);
      return result.result as { hasWorktree: boolean; dirty: boolean };
    }
    return getRemovalPreview(sessionId);
  })().then(value => value && typeof value.hasWorktree === 'boolean' && typeof value.dirty === 'boolean' ? value : null)
    .catch(() => null);
  const boundNames = withBudget(
    (async (): Promise<string[]> => {
      if (deviceId) {
        const list = await listRemoteBindings(deviceId);
        return list
          .filter((s) => s.targetSessionId === sessionId && s.status === 'active' && !s.persistentSession)
          .map((s) => s.name);
      }
      const [localList, workers] = await Promise.all([
        getScheduleStorageIfInitialized()?.list({ status: 'active' }) ?? Promise.resolve([] as Schedule[]),
        listWorkersByLead(sessionId).catch(() => []),
      ]);
      const localTargets = new Set<string>([sessionId]);
      const remoteTargetsByDevice = new Map<string, Set<string>>();
      for (const worker of workers) {
        if (worker.executionDevice) {
          let set = remoteTargetsByDevice.get(worker.executionDevice.deviceId);
          if (!set) {
            set = new Set();
            remoteTargetsByDevice.set(worker.executionDevice.deviceId, set);
          }
          set.add(worker.executionDevice.remoteSessionId);
        } else {
          localTargets.add(worker.sessionId);
        }
      }
      const remoteLists = remoteTargetsByDevice.size > 0
        ? await Promise.all(
            [...remoteTargetsByDevice.entries()].map(async ([remoteDeviceId, targetIds]) => [
              remoteDeviceId,
              targetIds,
              await listRemoteBindings(remoteDeviceId).catch(() => [] as Schedule[]),
            ] as const),
          )
        : [];
      const seen = new Set<string>();
      const names: string[] = [];
      const collect = (scope: string, list: readonly Schedule[], targets: ReadonlySet<string>) => {
        for (const s of list) {
          if (!s.targetSessionId || !targets.has(s.targetSessionId)) continue;
          if (s.status !== 'active' || s.persistentSession) continue;
          const key = `${scope}\0${s.id ?? s.name}`;
          if (seen.has(key)) continue;
          seen.add(key);
          names.push(s.name);
        }
      };
      collect('', localList, localTargets);
      for (const [remoteDeviceId, targetIds, list] of remoteLists) {
        collect(remoteDeviceId, list, targetIds);
      }
      return names;
    })(),
    [] as string[],
  );
  const [worktree, names] = await Promise.all([preview, boundNames]);
  if (worktree && !(worktree.hasWorktree && worktree.dirty) && names.length === 0) return true;
  const warning = names.length > 0
    ? t(`ccAgent.sidebar.confirmArchive.scheduleWarning_${names.length === 1 ? 'one' : 'other'}`)
      .replaceAll('{{names}}', names.map(name => t('ccAgent.sidebar.confirmArchive.scheduleName').replaceAll('{{name}}', name))
        .join(t('ccAgent.sidebar.confirmArchive.scheduleNameSeparator')))
    : '';
  const result = await dialog.showMessageBox({
    type: 'question', message: t('ccAgent.sidebar.confirmArchive.title'),
    detail: [t('ccAgent.sidebar.confirmArchive.description'),
      worktree?.dirty ? t('ccAgent.sidebar.confirmArchive.dirtyWorktreeWarning') : '', warning].filter(Boolean).join(' '),
    buttons: [t('ccAgent.sidebar.confirmArchive.confirm'), t('ccAgent.sidebar.confirmArchive.cancel')],
    defaultId: 1, cancelId: 1,
  });
  return result.response === 0;
}
