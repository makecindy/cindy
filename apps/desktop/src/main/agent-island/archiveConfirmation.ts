import { dialog } from 'electron';
import type { Schedule } from '@cindy/maker-scheduler';
import { normalizeOrcaDeviceId, parseOrcaTeamWorkers } from '@cindy/maker-shared/orca-team';
import { t } from '../i18n.desktop.js';
import { getSelfDeviceId, remoteInvoke } from '../device-link/index.js';
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

async function listRemoteWorkersByLead(deviceId: string, leadSessionId: string) {
  const result = await remoteInvoke(deviceId, 'local-db:orca-workflows:list-workers-by-lead', [leadSessionId]);
  return result.ok ? parseOrcaTeamWorkers(result.result) : [];
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
      const selfDeviceId = typeof getSelfDeviceId === 'function' ? getSelfDeviceId() : null;
      const ownerDevice = normalizeOrcaDeviceId(deviceId, selfDeviceId);
      const readLocalActive = () =>
        getScheduleStorageIfInitialized()?.list({ status: 'active' }) ?? Promise.resolve([] as Schedule[]);
      const [ownerList, workers] = await Promise.all([
        ownerDevice ? listRemoteBindings(ownerDevice).catch(() => [] as Schedule[]) : readLocalActive(),
        ownerDevice
          ? listRemoteWorkersByLead(ownerDevice, sessionId).catch(() => [])
          : listWorkersByLead(sessionId).catch(() => []),
      ]);
      const targetsByDevice = new Map<string | null, Set<string>>([[ownerDevice, new Set([sessionId])]]);
      const addTarget = (targetDevice: string | null, targetSessionId: string) => {
        let set = targetsByDevice.get(targetDevice);
        if (!set) {
          set = new Set();
          targetsByDevice.set(targetDevice, set);
        }
        set.add(targetSessionId);
      };
      for (const worker of workers) {
        if (worker.executionDevice) {
          addTarget(
            normalizeOrcaDeviceId(worker.executionDevice.deviceId, selfDeviceId),
            worker.executionDevice.remoteSessionId,
          );
        } else {
          addTarget(ownerDevice, worker.sessionId);
        }
      }
      const listsByDevice = new Map<string | null, Schedule[]>([[ownerDevice, ownerList]]);
      const extraDevices = [...targetsByDevice.keys()].filter((targetDevice) => targetDevice !== ownerDevice);
      if (extraDevices.length > 0) {
        const extraLists = await Promise.all(
          extraDevices.map(async (targetDevice) => [
            targetDevice,
            targetDevice
              ? await listRemoteBindings(targetDevice).catch(() => [] as Schedule[])
              : await readLocalActive().catch(() => [] as Schedule[]),
          ] as const),
        );
        for (const [targetDevice, list] of extraLists) {
          listsByDevice.set(targetDevice, list);
        }
      }
      const seen = new Set<string>();
      const names: string[] = [];
      for (const [targetDevice, targets] of targetsByDevice) {
        const scope = targetDevice ?? '';
        for (const s of listsByDevice.get(targetDevice) ?? []) {
          if (!s.targetSessionId || !targets.has(s.targetSessionId)) continue;
          if (s.status !== 'active') continue;
          const key = `${scope}\0${s.id ?? s.name}`;
          if (seen.has(key)) continue;
          seen.add(key);
          names.push(s.name);
        }
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
