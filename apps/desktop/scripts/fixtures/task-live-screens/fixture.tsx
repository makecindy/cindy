import {
  TaskLiveScreenButtons,
  TaskLiveScreenNotices,
  useAutoOpenTaskLiveScreens,
} from '../../../src/renderer/features/remote-desktop/TaskLiveScreenButtons';
import type { InstalledGhost } from '../../../src/shared/ghost';
import type { RemoteLiveScreen } from '@cindy/device-link';
import { mountPage, subscription } from '../../ui-page/harness';

const installed = {
  id: 'cindy-simulator',
  namespace: null,
  namespaceState: 'confirmed',
  enabled: true,
  approval: { state: 'approved', revision: 'fixture' },
  manifest: {
    id: 'cindy-simulator',
    name: 'Device Simulator',
    taskView: { html: 'task.html', remote: true },
  },
} as InstalledGhost;
const screens = [
  {
    plugin: '_root__cindy-simulator',
    pluginIdentity: '_root__cindy-simulator',
    pluginName: 'Device Simulator',
    id: 'a',
    name: 'iPhone Air',
    platform: 'ios',
    state: 'running',
    taskIds: ['fixture'],
  },
  {
    plugin: '_root__second',
    pluginIdentity: '_root__second',
    pluginName: 'Other device plugin',
    id: 'b',
    name: 'iPad',
    platform: 'ipados',
    state: 'running',
    taskIds: ['fixture'],
  },
  {
    plugin: 'cindy-simulator',
    pluginIdentity: '_root__cindy-simulator',
    pluginName: 'Device Simulator',
    id: 'a',
    name: 'iPhone Air',
    platform: 'ios',
    state: 'running',
    taskIds: ['fixture'],
  },
] as RemoteLiveScreen[];
const TASK_LIVE_SCREENS = { screens, loaded: true, unavailable: false };

/** The title-bar entries, and the task's composer stack where the ask waits. */
function TaskChrome() {
  const entries = useAutoOpenTaskLiveScreens('fixture', TASK_LIVE_SCREENS as never);
  return (
    <div className="flex min-h-screen flex-col gap-4 bg-content-area p-4 text-foreground">
      <div className="flex items-center gap-2">
        <TaskLiveScreenButtons sessionId="fixture" entries={entries} />
      </div>
      <div className="mt-auto flex w-full flex-col items-center gap-[10px]">
        <TaskLiveScreenNotices sessionId="fixture" style={{ width: '100%' }} className="py-1" />
        <div className="h-24 w-full rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)]" />
      </div>
    </div>
  );
}

void mountPage({
  route: '/',
  host: () => ({
    ghosts: {
      listSync: () => ({ ghosts: [installed] }),
      onChanged: subscription('ghostsChanged'),
    },
    pluginMarket: {
      lookup: async () => ({
        items: [{ pluginId: 'second', ghostId: 'second', namespace: null, installState: 'not-installed' }],
      }),
      detail: async () => ({
        pluginId: 'second', ghostId: 'second', namespace: null, installState: 'not-installed',
        releaseId: 'fixture-release', manifest: { id: 'second' },
      }),
      // Main's permission confirmation is outside this page: the install stays pending.
      install: () => new Promise(() => {}),
    },
  }),
  render: () => <TaskChrome />,
});
