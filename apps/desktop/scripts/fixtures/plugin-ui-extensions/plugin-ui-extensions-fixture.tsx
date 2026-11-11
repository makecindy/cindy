import { useState } from 'react';
import manifest from '../../../resources/system-skills/cindy-plugin-creator/references/examples/interactive-pages/host-ui/ghost.json';
import { getApprovedGhostHostUi, ghostHostUiApprovalTokens, type InstalledGhost } from '../../../src/shared/ghost';
import type { Session } from '../../../src/renderer/lib/ccAgent.types';
import { PluginUiProvider, PluginUiSlotControls, PluginUiSidebarSections, readPluginUiEntries } from '../../../src/renderer/cindy-brain/PluginUiContributions';
import { PluginUiCompletionBridge, type PluginUiCompletionResult } from '../../../src/renderer/cindy-brain/PluginUiCompletionBridge';
import { AtMentionPanel } from '../../../src/renderer/components/new-chat/AtMentionPanel';
import { ThumbnailStrip, AttachmentRejectionStrip } from '../../../src/renderer/components/new-chat/ComposerAttachments';
import { useAttachments } from '../../../src/renderer/hooks/useAttachments';
import { PluginSettingsFields } from '../../../src/renderer/components/settings/PluginSettingsSection';
import { SettingsSidebarNav } from '../../../src/renderer/components/settings/SettingsSidebarNav';
import { buildPluginSettingsPages, buildPluginSettingsSearchDocuments } from '../../../src/renderer/components/settings/pluginSettingsNavigation';
import { SessionTaskMenu } from '../../../src/renderer/features/cc-agent/sidebar/SessionTaskMenu';
import { DropdownMenu, DropdownMenuTrigger } from '../../../src/renderer/components/ui/dropdown-menu';
import { Button } from '../../../src/renderer/components/ui/button';
import { ContentHeaderSlot } from '../../../src/renderer/components/layout/ContentHeader';
import { FeatureSidebarSlotProvider } from '../../../src/renderer/features/feature-context';
import { ctx, mountPage } from '../../ui-page/harness';

// The isolated HTTP fixture needs local correlation IDs for attachment/provider calls.
if (!crypto.randomUUID) {
  let sequence = 0;
  crypto.randomUUID = () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`;
}
const ghost: InstalledGhost = { manifest: manifest as unknown as InstalledGhost['manifest'], enabled: true,
  dir: '/fixture', approval: { state: 'approved', revision: 'fixture' }, uiCapabilityApproved: true };
ghost.approvedHostUi = ghostHostUiApprovalTokens(ghost.manifest);
const fields = getApprovedGhostHostUi(ghost)!.settings!;
const pages = buildPluginSettingsPages([ghost]);
const documents = buildPluginSettingsSearchDocuments(pages, '插件设置');
const session = { id: 'fixture-task', title: '示例任务', status: 'active', messagesCount: 3 } as Session;
const noOp = () => {};
function InputScene() {
  const tray = useAttachments(undefined, 'fixture-draft');
  const [completion, setCompletion] = useState<PluginUiCompletionResult | null>(null);
  const [focused, setFocused] = useState(0);
  const entries = readPluginUiEntries('composer.completion');
  return <div className="space-y-5 py-6">
    <Button data-ui-page-control variant="secondary" size="md" onClick={() => {
      void tray.addFiles([new File(['# Example'], 'notes.md', { type: 'text/markdown' })]);
    }}>添加示例附件</Button>
    <div className="flex flex-col items-start gap-2">
      <AttachmentRejectionStrip rejections={tray.rejections} onDismiss={tray.dismissRejection} />
      <ThumbnailStrip attachments={tray.attachments} onRemove={tray.removeFile} onUpdate={tray.updateFile} />
    </div>
    {entries.length > 0 && <PluginUiCompletionBridge entries={entries} sessionId={null}
      request={{ key: 'fixture-query', trigger: '@', query: '记录', from: 0 }} onResult={setCompletion} />}
    <AtMentionPanel embedded query="记录" state={{ kind: 'ready', items: [], truncated: false }}
      entries={(completion?.items ?? []).map(item => ({ kind: 'action', action: {
        id: `plugin-completion:${item.id}`, label: `${item.label} · ${item.source}`, run: noOp,
      } }))} focusedIndex={focused} onFocusedIndexChange={setFocused}
      onSelect={noOp} onClose={noOp} onRetry={noOp} />
  </div>;
}
function Scene() {
  const [menuOpen, setMenuOpen] = useState(false);
  const entries = readPluginUiEntries('sidebar.navigation');
  const sections = readPluginUiEntries('sidebar.section');
  const titlebar = readPluginUiEntries('window.titlebar');
  return <div className="flex h-full min-w-0 bg-[var(--settings-bg)] text-[var(--text-primary)]">
    <aside className="flex w-60 shrink-0 flex-col gap-5 border-r border-[var(--border-default)] p-4">
      {entries.length > 0 && <PluginUiSlotControls entries={entries} appearance="navigation" />}
      {sections.length > 0 && <PluginUiSidebarSections entries={sections} sessionId={null} />}
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
      <ContentHeaderSlot sidebarVisible showCollapsedActions={false} isSidebarRail={false} rightSidebarAvailable={false}
        trailing={titlebar.length > 0 ? <PluginUiSlotControls entries={titlebar} appearance="titlebar" /> : undefined}>
      {ctx.case === 'input' || ctx.case === 'attachment-error' ? <InputScene />
        : <PluginSettingsFields instanceId={pages[0].instanceId} title={manifest.name} fields={fields} />}
      </ContentHeaderSlot>
    </main>
  </div>;
}
let value: Record<string, unknown> = Object.fromEntries(fields.map(field => [field.id, field.default]));
const defaults = { ...value };
void mountPage({ host: {
  ghosts: { listSync: () => ({ ghosts: [ghost] }), onChanged: () => noOp },
  getFilePath: (file: File) => `/fixture/${file.name}`,
  getFileThumbnail: async () => null,
  cleanupStagedChatAttachments: async () => {},
  maker: { mcpApps: async (_session, input) => {
    if (input.op === 'plugin-settings') {
      if (input.operation === 'update') value = { ...value, ...input.patch };
      if (input.operation === 'reset') value = { ...defaults };
      return { state: { value, defaults, customizedKeys: Object.keys(value).filter(key => value[key] !== defaults[key]) } };
    }
    if (input.op === 'plugin-action' && input.id === 'completion') return { structuredContent: {
      items: [{ id: 'record', label: '示例引用：记录', insertText: '记录 #1' }],
    } };
    if (input.op === 'plugin-action' && input.id === 'attachment') {
      if (ctx.case === 'attachment-error') throw new Error('MCP_APP_ACTION_FAILED');
      return { handled: true, files: [{ name: 'prepared-notes.md', path: '/fixture/output.bin', size: 9, mimeType: 'text/markdown' }] };
    }
    return { updates: [] };
  }, onPluginUiState: () => noOp },
  sharedTask: { host: async () => ({ detail: null }) },
  appPreferenceControl: { onSettingsChanged: () => noOp },
}, render: () => <FeatureSidebarSlotProvider isCollapsed={false}><PluginUiProvider><Scene /></PluginUiProvider></FeatureSidebarSlotProvider> });
