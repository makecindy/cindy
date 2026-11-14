import { createOverrideSettingsFile } from '../maker-host/override-settings-file.js';
import {
  activeDataOwnerId,
  ownerGeneration,
  isOwnerBoundaryPending,
  ownerScopedPath,
} from '../ownerContext.js';
import { createLogger } from '../logger.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import {
  DEFAULT_TASK_ARCHIVE_SETTINGS,
  TASK_ARCHIVE_DAY_MS,
  type TaskArchiveSettings,
} from '../../shared/taskManagement.js';

export const DAY_MS = TASK_ARCHIVE_DAY_MS;
export function taskManagementScope(): string {
  const owner = activeDataOwnerId();
  if (!owner || isOwnerBoundaryPending())
    throwIpcError('PRECONDITION_FAILED', 'Task owner is not ready');
  return `${owner}:${ownerGeneration()}`;
}
export function validArchiveDays(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 365;
}
export function createTaskManagementStore(options: {
  filePath(name: string): string;
  scopeKey(): string;
}) {
  const common = {
    scopeKey: options.scopeKey,
    log: createLogger('task-management'),
    preserveUnreadableFile: true,
    logLoadedValue: false,
    logReadErrorDetails: false,
  };
  const settings = createOverrideSettingsFile<
    TaskArchiveSettings & { restoredAt: Record<string, number> }
  >({
    ...common,
    filePath: () => options.filePath('task-management.json'),
    label: 'task management',
    defaults: { ...DEFAULT_TASK_ARCHIVE_SETTINGS, restoredAt: {} },
    maxBytes: 8 * 1024 * 1024,
    normalize(raw) {
      const value = raw as
        (Partial<TaskArchiveSettings> & { restoredAt?: Record<string, number> }) | null;
      return {
        enabled: value?.enabled === true,
        days: validArchiveDays(value?.days) ? value.days : 7,
        restoredAt: Object.fromEntries(
          Object.entries(
            value?.restoredAt && typeof value.restoredAt === 'object' ? value.restoredAt : {},
          ).filter(
            ([id, at]) => id.length > 0 && typeof at === 'number' && Number.isFinite(at) && at > 0,
          ),
        ),
      };
    },
  });
  return {
    read(): TaskArchiveSettings {
      options.scopeKey();
      settings.invalidateIfChanged();
      const { enabled, days } = settings.read();
      return { enabled, days };
    },
    async update(patch: Partial<TaskArchiveSettings>) {
      options.scopeKey();
      if (
        (patch.days !== undefined && !validArchiveDays(patch.days)) ||
        (patch.enabled !== undefined && typeof patch.enabled !== 'boolean')
      ) {
        throwIpcError('INVALID_PARAMS', 'Invalid task archive settings');
      }
      await settings.writePatchAtomic(patch, { preserveDefaults: true });
      return this.read();
    },
    async reset() {
      options.scopeKey();
      await settings.writePatchAtomic(DEFAULT_TASK_ARCHIVE_SETTINGS);
      return this.read();
    },
    restoredAt() {
      options.scopeKey();
      settings.invalidateIfChanged();
      return settings.read().restoredAt;
    },
    async restored(ids: readonly string[], now: number) {
      options.scopeKey();
      if (!ids.length) return;
      await settings.updateAtomic(({ value }) => ({
        restoredAt: {
          ...Object.fromEntries(
            Object.entries(value.restoredAt).filter(([, at]) => at > now - 365 * DAY_MS),
          ),
          ...Object.fromEntries(ids.map((id) => [id, now])),
        },
      }));
    },
  };
}
export const taskManagementStore = createTaskManagementStore({
  filePath: ownerScopedPath,
  scopeKey: taskManagementScope,
});
