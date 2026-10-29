import { dialog } from 'electron';
import type { Schedule } from '@cindy/maker-scheduler';
import { t } from '../i18n.js';
import { remoteInvoke } from '../device-link/index.js';
import { getRemovalPreview } from '../worktree/WorktreeManager.js';
import { getScheduleStorageIfInitialized } from '../scheduler-host/index.js';

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
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const schedules = Promise.race([
    (async () => {
      if (deviceId) {
        const result = await remoteInvoke(deviceId, 'maker:schedule:list', [null, { sessionBindings: true }]);
        return result.ok && Array.isArray(result.result) ? result.result as Schedule[] : [];
      }
      return await getScheduleStorageIfInitialized()?.list({ status: 'active' }) ?? [];
    })().catch(() => [] as Schedule[]),
    new Promise<Schedule[]>(resolve => { timeout = setTimeout(() => resolve([]), 1500); }),
  ]).finally(() => clearTimeout(timeout));
  const [worktree, list] = await Promise.all([preview, schedules]);
  const names = list.filter(s => s.targetSessionId === sessionId && s.status === 'active' && !s.persistentSession)
    .map(s => s.name);
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
