import {
  TaskLiveScreenButtons,
  taskLiveScreenEntries,
} from '../../../src/renderer/features/remote-desktop/TaskLiveScreenButtons';
import type { InstalledGhost } from '../../../src/shared/ghost';
import type { RemoteLiveScreen } from '@cindy/device-link';
import { mountPage } from '../../ui-page/harness';

const installed = {
  id: 'cindy-simulator',
  namespace: null,
  namespaceState: 'confirmed',
  enabled: true,
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
void mountPage({
  route: '/',
  render: () => (
    <div className="flex min-h-screen items-start gap-2 bg-content-area p-4 text-foreground">
      <TaskLiveScreenButtons
        sessionId="fixture"
        entries={taskLiveScreenEntries(screens, [installed])}
      />
    </div>
  ),
});
