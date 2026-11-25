import { forbid, mountPage } from '../../ui-page/harness';
import { setDataOwnerGeneration } from '../../../src/renderer/contexts/dataOwnerGeneration';
import { CloudInstanceAccessProvider } from '../../../src/renderer/features/cloud-settings/CloudInstanceAccess';
import {
  ProjectsSection,
  type ProjectsSectionProps,
} from '../../../src/renderer/features/cc-agent/sidebar/sections/ProjectsSection';

setDataOwnerGeneration('fixture-owner', 1);
const noop = () => {};
const filter = {
  creators: 'all', creatorOptions: [], toggleCreator: noop, setCreatorsAll: noop, setCreatorsNone: noop,
  groupBy: 'project', groupDialogue: true, groupDevice: true, sortBy: 'recency',
  projectOrder: 'activity', manualProjectOrder: [], projects: 'all', status: 'active',
  isFilterActive: false, projectsAsSet: null, isSessionContentFiltered: false, vendor: 'all',
  lastActivity: 'all', manualPinnedOrder: [], setStatus: noop, toggleProject: noop,
  ensureProjectIncluded: noop, setProjectsAll: noop, gc: noop, setVendor: noop,
  setLastActivity: noop, setGroupBy: noop, setGroupDialogue: noop, setGroupDevice: noop,
  setSortBy: noop, setProjectOrder: noop, resetContentFilters: noop, setManualProjectOrder: noop,
  setManualPinnedOrder: noop, promotePin: noop, removePin: noop,
} as unknown as ProjectsSectionProps['filter'];
const props = new Proxy(
  {
    unclassified: [], projects: [], dialogues: [], allKnownProjects: [], allProjectKeysForOrder: [],
    bots: [], filter, collapsed: new Set(), isAllCollapsed: false, runningSessionIds: new Set(),
    attachedSessionIds: new Set(), notifications: new Set(), scheduleSessionIndex: new Map(),
    linkingCodexProject: null,
    // An online cloud instance appears as a device header, as any remote device (no settings shortcut).
    remoteDeviceIndex: new Map([
      ['cloud-device-0123456789abcdef01234567', { name: '我的云端 Cindy', online: true }],
    ]),
  } as Record<string, unknown>,
  { get: (target, key: string) => (key in target ? target[key] : noop) },
) as unknown as ProjectsSectionProps;

// Device-link reads used by the sidebar's device hooks: no devices, events never fire.
const deviceLink = {
  listDevices: async () => ({ devices: [] }),
  getStatus: async () => null,
  onAccessRevoked: () => noop,
  onConnectionIssue: () => noop,
  onControlTargetChanged: () => noop,
  onControlledState: () => noop,
  onKeepAwakeChanged: () => noop,
  onOwnershipChanged: () => noop,
  onPeerLinkReopened: () => noop,
  onPeerLinkReset: () => noop,
  onPresenceChanged: () => noop,
  onRemotePush: () => noop,
  onResponsivenessChanged: () => noop,
  onStatusChanged: () => noop,
};

mountPage({
  route: '/cc-agent/new',
  host: {
    platform: 'darwin',
    deviceLink,
    cloudSettings: {
      instanceAccess: async () => ({ schemaVersion: 1, allowed: true }),
      // The project area lists no CIS instances of its own, not even an asleep instance
      // missing from the device list.
      instanceList: forbid('cloudSettings.instanceList'),
    },
  },
  render: () => (
    <CloudInstanceAccessProvider>
      <aside className="w-full max-w-[280px] p-3" data-sidebar-fixture>
        <ProjectsSection {...props} />
      </aside>
    </CloudInstanceAccessProvider>
  ),
});
