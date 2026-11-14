import { ctx, mountPage, subscription } from '../../ui-page/harness';
import { TaskManagementSection } from '../../../src/renderer/components/settings/TaskManagementSection';
import type { TaskArchiveSettings } from '../../../src/shared/taskManagement';
import { DEFAULT_APPEARANCE_SETTINGS } from '../../../src/shared/appearanceSettings';

let settings: TaskArchiveSettings = { enabled: ctx.case === 'enabled', days: 7 };
let unavailable = ctx.case === 'unavailable';
const writes: unknown[] = [];
const changed = new Set<() => void>();
let previewReads = 0;
Object.assign(window, {
  archiveFixture: {
    writes, settings: () => settings, previewReads: () => previewReads,
    recover: () => { unavailable = false; changed.forEach((listener) => listener()); },
  },
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
      read: async () => {
        if (unavailable) throw new Error('Fixture settings unavailable');
        return { ...settings };
      },
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
        throw new Error('Settings must not request archive counts');
      },
    },
  },
  render: () => (
    <div className="mx-auto max-w-5xl p-6">
      <TaskManagementSection />
    </div>
  ),
});
