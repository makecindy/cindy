import { useEffect, useState, type ReactNode } from 'react';
import { MonitorSmartphone, ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { DeviceSectionHeader } from '../../../src/renderer/features/cc-agent/sidebar/DeviceSectionHeader';
import type { ProjectNode } from '../../../src/renderer/features/cc-agent/lib/projectGrouping';
import { projectFilesRoute } from '../../../src/renderer/features/cc-agent/workdir-browse/lib/docModeSwitchProjects';
import { useConfirmDialog } from '../../../src/renderer/components/ui/confirm-dialog-provider';
import { useSessionGroupArchive } from '../../../src/renderer/features/cc-agent/hooks/useSessionGroupArchive';
import { HeaderProjectDropdown } from '../../../src/renderer/features/cc-agent/sidebar/HeaderProjectDropdown';
import { useHeaderProjectMenu } from '../../../src/renderer/state/headerProjectMenu';
import { SessionProjectMenuButton } from '../../../src/renderer/features/cc-agent/sidebar/SessionProjectMenuButton';
import type { Session } from '../../../src/renderer/lib/ccAgent.types';
import { ctx as page, mountPage, subscription } from '../../ui-page/harness';
import { ProjectSettingsDialog } from '../../../src/renderer/features/cc-agent/sidebar/ProjectSettingsDialog';
import { setDataOwnerGeneration } from '../../../src/renderer/contexts/dataOwnerGeneration';
import { remoteProjectsStore } from '../../../src/renderer/features/device-link/remoteProjectsStore';
import { recentWorkdirsStore } from '../../../src/renderer/lib/recentWorkdirsStore';
// This isolated HTTP fixture lacks secure-context UUID support. Production uses Chromium's crypto.
if (!crypto.randomUUID) {
  let sequence = 0;
  crypto.randomUUID = () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`;
}
setDataOwnerGeneration('fixture', 1);
// Only the intro case starts as someone who has no project yet and has not seen the introduction.
if (!page.data.intro) localStorage.setItem('featureIntro.project.seen', '1');
const writes: unknown[] = [];
const pickerScopes: unknown[] = [];
Object.assign(window, { projectSettingsWrites: writes, projectPickerScopes: pickerScopes });
function FixtureDropdown() {
  const request = useHeaderProjectMenu();
  const [project, setProject] = useState<ProjectNode | null>(null);
  const [isPinned, setPinned] = useState(false);
  const { confirm, confirmWithCheckbox } = useConfirmDialog();
  const noop = () => {};
  const archive = useSessionGroupArchive({
    sessions: [],
    status: 'active',
    runningSessionIds: new Set(),
    confirmDialog: confirm,
    refreshSessions: async () => {},
    patchLocal: noop,
    navigate: noop,
  });
  if (project) return (
    <ProjectSettingsDialog
      project={project}
      isPinned={isPinned}
      onTogglePin={(_, pinned) => setPinned(!pinned)}
      onImport={(target) => Object.assign(window, { importTarget: target.projectKey })}
      onRemove={(target) => void archive({
        kind: 'project', project: target,
        removal: { confirm: confirmWithCheckbox, finish: async () => {
          Object.assign(window, { removedProject: target.projectKey });
        } },
      })}
      onClose={() => setProject(null)}
    />
  );
  if (!request) return null;
  return (
    <HeaderProjectDropdown
      request={request}
      project={request.project}
      statusFilter="active"
      onSettings={setProject}
      onCreateInProject={(project) => {
        Object.assign(window, { createdProjectKey: project.projectKey });
      }}
      onOpenConversationSearch={noop}
      onBrowseFiles={(project) => {
        Object.assign(window, { projectFilesHref: projectFilesRoute(project, 'header-task', project.sessions) });
      }}
      onOpenInExplorer={noop}
      onArchiveAll={(project) => void archive({ kind: 'project', project })}
    />
  );
}
function DeviceEntry({ enabled, children }: { enabled: boolean; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const { t } = useTranslation();
  // The sidebar keeps this computer's project list loaded; the introduction reads it.
  useEffect(() => {
    if (page.data.intro) {
      // This isolated fixture has no remote devices; discovery has completed.
      const settleDiscovery = remoteProjectsStore.beginInitialDiscovery();
      settleDiscovery();
      void recentWorkdirsStore.ensure();
    }
  }, []);
  if (!enabled) return children(() => {});
  return <div className="max-w-80 p-4">
    <DeviceSectionHeader deviceId={null} name={t('ccAgent.sidebar.deviceGroup.local')} onCreateProject={() => setOpen(true)}>
      <button type="button" aria-expanded={!collapsed} onClick={() => setCollapsed(!collapsed)} className="flex h-6 min-w-0 flex-1 items-center gap-1.5 rounded-full px-2 text-xs text-[var(--sidebar-list-muted)]">
        <MonitorSmartphone size={13} /><span>{t('ccAgent.sidebar.deviceGroup.local')}</span><ChevronDown size={12} />
      </button>
    </DeviceSectionHeader>
    {open && children(() => setOpen(false))}
  </div>;
}
mountPage({
  host: (ctx) => ({
    maker: { closeSession: async () => {}, schedule: { list: async () => [] } },
    deviceLink: {
      invoke: async (
        deviceId: string,
        channel: string,
        [request]: Array<{ operation?: string; directory?: string } | null>,
      ) => {
        if (deviceId !== 'fixture-studio') throw new Error('Unexpected target device');
        if (channel === 'maker:schedule:list') return [];
        if (
          channel === 'local-db:sessions:project-archive' &&
          request?.operation === 'preview' &&
          request.directory === '/Projects/Cindy'
        )
          return [
            { id: 'header-task', blocked: null, hasWorktree: false },
            { id: 'second-task', blocked: null, hasWorktree: false },
            { id: 'pinned-task', blocked: 'pinned', hasWorktree: false },
          ];
        writes.push(request);
        throw new Error('Unexpected remote project action');
      },
    },
    dialog: {
      showOpenDirectory: async (options?: { projectGrantScope?: string }) => {
        pickerScopes.push(options?.projectGrantScope);
        return ({
        success: true,
        path:
          (window as unknown as { projectPickerCancelled?: boolean }).projectPickerCancelled ===
          true
            ? null
            : ((window as unknown as { projectPickerPath?: string }).projectPickerPath ??
              '/Projects/Reference'),
      });
      },
    },
    localDb: {
      sessions: {
        projectArchive: async (request: { action: string; operation: string; directory: string; sessionId?: string }) => {
          if (request.action !== 'archiveOnRemoval' || request.directory !== '/Projects/Cindy') throw new Error('Wrong removal target');
          if (request.operation === 'preview') return [
            { id: 'header-task', blocked: null, hasWorktree: true },
            { id: 'pinned-task', blocked: 'pinned', hasWorktree: false },
          ];
          if (request.sessionId !== 'header-task') throw new Error('Protected task archived');
          Object.assign(window, { archivedTask: request.sessionId });
          return 'updated';
        },
      },
      recentWorkdirs: { list: async () => [] },
      projectAliases: {
        snapshot: async () => ({
          aliases: [{ projectKey: 'local:/Projects/Cindy', alias: 'Cindy' }],
          icons: ctx.data.automatic ? {} : { 'local:/Projects/Cindy': '🚀' },
          platform: 'darwin',
          settingsSupported: true,
          creationRoot: '/Projects',
          settingsVersion: ctx.data.version ?? 7,
          directories: ctx.data.directories
            ? { 'local:/Projects/Cindy': [{ path: '/Projects/Reference', access: 'read' }] }
            : {},
          ownerStamp: { dataOwnerId: 'fixture', ownerGeneration: 1 },
        }),
        iconImage: async () => null,
        autoIcon: async () => ({
          image: ctx.data.artwork ?? null,
          source: ctx.data.candidate ? 'https://github.com/example' : 'assets/icon.png',
          kind: ctx.data.candidate ? 'github' : 'local',
          candidate: !!ctx.data.candidate,
        }),
        onChanged: subscription('projectInfoChanged'),
        updateInfo: async (request: unknown) => {
          writes.push(request);
          const body = request as { projectKey: string; create?: boolean; value?: { name?: string } };
          return { createdProjectKey: body.create ? (body.projectKey === 'local:' ? `local:/Projects/${body.value?.name || 'Project'}` : body.projectKey) : undefined };
        },
      },
    },
  }),
  render: (ctx) =>
    ctx.data.header ? (
      <div className="flex items-center p-6">
        <SessionProjectMenuButton
          session={
            {
              id: 'header-task',
              ...(ctx.data.remote && {
                deviceLinkDeviceId: 'fixture-studio',
                deviceLinkDeviceName: 'Studio',
              }),
              workspaceKind: 'project',
              workingDir: '/Projects/Cindy/.worktrees/task',
              projectDir: '/Projects/Cindy',
              updatedAt: '',
            } as Session
          }
        />
        <FixtureDropdown />
        <span>Task in a worktree</span>
      </div>
    ) : (
      <DeviceEntry enabled={ctx.case === 'create-device' || !!ctx.data.intro}>
      {(close) => <ProjectSettingsDialog
        create={!!ctx.data.create}
        onClose={close}
        onCreated={(path) => Object.assign(window, { projectCreatedPath: path })}
        project={{
          projectKey: 'local:/Projects/Cindy',
          workingDir: ctx.data.create ? '' : '/Projects/Cindy',
          displayName: ctx.data.create ? '' : 'Cindy',
          scope: 'local',
          remoteHostId: null,
          deviceLinkDeviceId: null,
          deviceLinkDeviceName: null,
          deviceLinkConnectionStatus: null,
          segments: 1,
          sessions: [],
          latestActivityAt: '',
        }}
      />}
      </DeviceEntry>
    ),
});
