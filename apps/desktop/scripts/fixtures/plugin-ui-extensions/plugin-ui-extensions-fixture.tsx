import { useState } from 'react';
import manifest from '../../../resources/system-skills/cindy-plugin-creator/references/examples/interactive-pages/host-ui/ghost.json';
import { getApprovedGhostHostUi, ghostHostUiApprovalTokens, type InstalledGhost } from '../../../src/shared/ghost';
import type { Session } from '../../../src/renderer/lib/ccAgent.types';
import { PluginUiProvider, PluginUiSlotControls, readPluginUiEntries } from '../../../src/renderer/cindy-brain/PluginUiContributions';
import { PluginSettingsFields } from '../../../src/renderer/components/settings/PluginSettingsSection';
import { SettingsSidebarNav } from '../../../src/renderer/components/settings/SettingsSidebarNav';
import { buildPluginSettingsPages, buildPluginSettingsSearchDocuments } from '../../../src/renderer/components/settings/pluginSettingsNavigation';
import { SessionTaskMenu } from '../../../src/renderer/features/cc-agent/sidebar/SessionTaskMenu';
import { DropdownMenu, DropdownMenuTrigger } from '../../../src/renderer/components/ui/dropdown-menu';
import { Button } from '../../../src/renderer/components/ui/button';
import { mountPage } from '../../ui-page/harness';

const ghost: InstalledGhost = { manifest: manifest as unknown as InstalledGhost['manifest'], enabled: true,
  dir: '/fixture', approval: { state: 'approved', revision: 'fixture' }, uiCapabilityApproved: true };
ghost.approvedHostUi = ghostHostUiApprovalTokens(ghost.manifest);
const fields = getApprovedGhostHostUi(ghost)!.settings!;
const pages = buildPluginSettingsPages([ghost]);
const documents = buildPluginSettingsSearchDocuments(pages, '插件设置');
const session = { id: 'fixture-task', title: '示例任务', status: 'active', messagesCount: 3 } as Session;
const noOp = () => {};
function Scene() {
  const [menuOpen, setMenuOpen] = useState(false);
  const entries = readPluginUiEntries('sidebar.navigation');
  return <div className="flex h-full min-w-0 bg-[var(--settings-bg)] text-[var(--text-primary)]">
    <aside className="flex w-60 shrink-0 flex-col gap-5 border-r border-[var(--border-default)] p-4">
      {entries.length > 0 && <PluginUiSlotControls entries={entries} appearance="navigation" />}
      <SettingsSidebarNav tabIds={['general', 'ghosts']} activeTab="ghosts" onSelectTab={noOp}
        pluginPages={pages} pluginSearchDocuments={documents} selectedPluginPage={pages[0].id} />
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild><Button variant="secondary" size="md">任务操作</Button></DropdownMenuTrigger>
        <SessionTaskMenu session={session} open={menuOpen} writeBlocked={false} returnFocus={noOp}
          onRename={noOp} onPin={noOp} onArchive={noOp} onUnarchive={noOp} onDelete={noOp} onOpenInNewWindow={noOp}
          move={null} tags={null} copy={null} exportShare={null} />
      </DropdownMenu>
    </aside>
    <main className="min-w-0 flex-1 overflow-y-auto px-6">
      <PluginSettingsFields instanceId={pages[0].instanceId} title={manifest.name} fields={fields} />
    </main>
  </div>;
}
let value: Record<string, unknown> = Object.fromEntries(fields.map(field => [field.id, field.default]));
const defaults = { ...value };
void mountPage({ host: {
  ghosts: { listSync: () => ({ ghosts: [ghost] }), onChanged: () => noOp },
  maker: { mcpApps: async (_session, input) => {
    if (input.op === 'plugin-settings') {
      if (input.operation === 'update') value = { ...value, ...input.patch };
      if (input.operation === 'reset') value = { ...defaults };
      return { state: { value, defaults, customizedKeys: Object.keys(value).filter(key => value[key] !== defaults[key]) } };
    }
    return { updates: [] };
  }, onPluginUiState: () => noOp },
  sharedTask: { host: async () => ({ detail: null }) },
  appPreferenceControl: { onSettingsChanged: () => noOp },
}, render: () => <PluginUiProvider><Scene /></PluginUiProvider> });
