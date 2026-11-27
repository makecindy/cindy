import { useMemo, useState } from 'react';
import { ctx, mountPage, subscription } from '../../ui-page/harness';
import { SidebarFilterPopover } from '../../../src/renderer/features/cc-agent/sidebar/SidebarFilterPopover';
import { persistCreators } from '../../../src/renderer/features/cc-agent/hooks/helpers/sidebarFilterCore';
import { useTaskInfoFields } from '../../../src/renderer/features/cc-agent/hooks/useTaskInfoFields';
import { useSidebarFilter } from '../../../src/renderer/features/cc-agent/hooks/useSidebarFilter';
import { BotFollowMark, useSessionFollowers } from '../../../src/renderer/features/bots/BotFollowMark';
import { matchesTaskCreators, useTaskCreatorIndex, useTaskCreatorOptions } from '../../../src/renderer/features/bots/botFollowScopes';
import { resetCompanionCloudStoreForTests } from '../../../src/renderer/features/bots/companionCloudStore';
import { setDataOwnerGeneration } from '../../../src/renderer/contexts/dataOwnerGeneration';
import type { Session } from '../../../src/renderer/lib/ccAgent.types';

const snapshot = { dataOwnerId: 'fixture', ownerGeneration: 1, pinnedOrderIsAuthoritative: true,
  pinnedOrder: [], hiddenProjectKeys: [], hiddenMainViewGhostIds: [] };
const tasks = [
  { id: 'owner', title: 'Personal task' },
  { id: 'cindy-local', title: 'Cindy · Local task' },
  { id: 'cindy-remote', title: 'Cindy · Remote task', deviceLinkDeviceId: 'laptop' },
  { id: 'routine', title: 'Cindy · Daily routine', source: 'bot', companion: { id: 'cindy-default', role: 'routine' } },
  { id: 'channel', title: 'Cindy · Feishu conversation', source: 'bot', deviceLinkDeviceId: 'laptop', companion: { id: 'remote-cindy', role: 'channel', channel: 'feishu' } },
  { id: 'local', title: 'Dash · Local task' },
  { id: 'remote', title: 'Lizi · Remote task', status: 'archived', deviceLinkDeviceId: 'laptop' },
].map(row => ({ status: 'active', source: 'desktop', ...row }) as Session);
// A harness a plugin provides; its name comes from the plugin list of this computer.
const PLUGIN_HARNESSES = [{ key: 'acp-plugin:demo-plugin:orbit', providerId: 'acp-plugin:demo-plugin:orbit' }];
function TaskRow({ task }: { task: Session }) {
  const { fields } = useTaskInfoFields();
  const followers = useSessionFollowers(task);
  return <div className="flex items-center gap-2 py-2" data-task={task.id}>
    {fields.includes('teammate') && <BotFollowMark followers={followers} />}<span>{task.title}</span>
  </div>;
}
function Fixture() {
  useState(() => { persistCreators(['["companion","remote-cindy"]'], 'fixture'); return true; });
  const options = useTaskCreatorOptions();
  const hidden = useMemo(() => new Set<string>(), []);
  const filter = useSidebarFilter(hidden, snapshot, options);
  const index = useTaskCreatorIndex();
  const [open, setOpen] = useState(true);
  return <div className="p-4 text-14 text-foreground">
    <SidebarFilterPopover filter={filter} allKnownProjects={[]} open={open} onOpenChange={setOpen}
      {...(ctx.case === 'layout' ? { hasRemoteDevices: true, pluginHarnesses: PLUGIN_HARNESSES } : null)} />
    <div className="mt-64" data-testid="tasks">
      {tasks.filter(task => matchesTaskCreators(task, filter.creators, index)).map(task => <TaskRow key={task.id} task={task} />)}
    </div>
  </div>;
}
mountPage({
  host: () => {
    setDataOwnerGeneration('fixture', 1);
    resetCompanionCloudStoreForTests({ enabled: true, selfDeviceId: 'desktop', humanActorId: 'human', demotedBotIds: [],
      actors: [{ id: 'actor', externalId: 'remote-cindy', name: 'Cindy', avatar: null, homeDeviceId: 'laptop' }] });
    return {
      authHasPersistedSessionHintSync: () => false,
      appearanceSettings: undefined,
      setApplicationMenuLocale: async () => {},
      setUpdateRelaunchTheme: async () => {},
      sidebarSettings: {
        loadSnapshot: () => snapshot,
        claimLegacyRendererOwner: () => ({ ...snapshot, claimed: true, canInitialize: true, pinnedLegacyConsumed: true }),
        onPinnedOrderChanged: subscription('pinned'),
      },
      maker: {
        onBotWorkbenchChanged: subscription('workbench'),
        listPluginEngines: async () => [{ key: 'demo-plugin:orbit', providerId: 'acp-plugin:demo-plugin:orbit', name: 'Orbit', models: [] }],
        onPluginEnginesChanged: subscription('plugin-engines'),
      },
      localDb: { bots: { workbench: { followScopes: async () => [
        { botId: 'cindy-default', delegatedSessionIds: ['cindy-local'] },
        { botId: 'dash', sessionIds: ['local', 'owner'], delegatedSessionIds: ['local'] },
      ] } } },
    };
  },
  render: () => <Fixture />,
});
