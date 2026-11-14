import { ctx, mountPage, subscription } from '../../ui-page/harness';
import { TaskManagementSection } from '../../../src/renderer/components/settings/TaskManagementSection';
import type { TaskArchiveSettings } from '../../../src/shared/taskManagement';
import { DEFAULT_APPEARANCE_SETTINGS } from '../../../src/shared/appearanceSettings';

let settings: TaskArchiveSettings = { enabled: ctx.case === 'many-tasks', days: 7 };
const writes: unknown[] = [];
const changed = new Set<() => void>();
let previewReads = 0;
Object.assign(window, {
  archiveFixture: { writes, settings: () => settings, previewReads: () => previewReads },
});
mountPage({
  route: '/settings?tab=storage&section=task-management',
  host: {
    authHasPersistedSessionHintSync: () => false,
    appearanceSettings: {
      getSync: () => DEFAULT_APPEARANCE_SETTINGS,
      onChanged: subscription('appearance'),
    },
    taskManagement: {
      read: async () => ({ ...settings }),
      update: async (patch: Partial<TaskArchiveSettings>) => {
        writes.push(patch);
        settings = { ...settings, ...patch };
        changed.forEach((listener) => listener());
        return { ...settings };
      },
      reset: async () => {
        settings = { enabled: false, days: 7 };
        changed.forEach((listener) => listener());
        return { ...settings };
      },
      onChanged: (listener: () => void) => {
        changed.add(listener);
        return () => changed.delete(listener);
      },
      onArchived: subscription('archive-notice'),
      preview: async () => {
        previewReads++;
        if (ctx.case === 'unavailable') throw new Error('Fixture preview unavailable');
        const total = ctx.case === 'many-tasks' ? 300000 : 5;
        const candidateCount = settings.enabled
          ? ctx.case === 'many-tasks'
            ? 100000
            : [10, 25].filter((days) => days >= settings.days).length
          : 0;
        return {
          candidateCount,
          keptCount: total - candidateCount,
          lastCheckAt: null,
        };
      },
    },
  },
  render: () => (
    <div className="mx-auto max-w-5xl p-6">
      <TaskManagementSection />
    </div>
  ),
});
