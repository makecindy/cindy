import { useState } from 'react';
import type { ProjectNode } from '../../../src/renderer/features/cc-agent/lib/projectGrouping';
import { projectFilesRoute } from '../../../src/renderer/features/cc-agent/workdir-browse/lib/docModeSwitchProjects';
import { useConfirmDialog } from '../../../src/renderer/components/ui/confirm-dialog-provider';
import { useSessionGroupArchive } from '../../../src/renderer/features/cc-agent/hooks/useSessionGroupArchive';
import { HeaderProjectDropdown } from '../../../src/renderer/features/cc-agent/sidebar/HeaderProjectDropdown';
import { useHeaderProjectMenu } from '../../../src/renderer/state/headerProjectMenu';
import { SessionProjectMenuButton } from '../../../src/renderer/features/cc-agent/sidebar/SessionProjectMenuButton';
import type { Session } from '../../../src/renderer/lib/ccAgent.types';
import { mountPage, subscription } from '../../ui-page/harness';
import { ProjectSettingsDialog } from '../../../src/renderer/features/cc-agent/sidebar/ProjectSettingsDialog';
import { setDataOwnerGeneration } from '../../../src/renderer/contexts/dataOwnerGeneration';
setDataOwnerGeneration('fixture', 1);
const writes: unknown[] = [];
Object.assign(window, { projectSettingsWrites: writes });
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
      projectAliases: {
        snapshot: async () => ({
          aliases: [{ projectKey: 'local:/Projects/Cindy', alias: 'Cindy' }],
          icons: ctx.data.automatic ? {} : { 'local:/Projects/Cindy': '🚀' },
          platform: 'darwin',
          settingsSupported: true,
          settingsVersion: ctx.data.version ?? 5,
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
          return {};
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
      <ProjectSettingsDialog
        onClose={() => {}}
        project={{
          projectKey: 'local:/Projects/Cindy',
          workingDir: '/Projects/Cindy',
          displayName: 'Cindy',
          scope: 'local',
          remoteHostId: null,
          deviceLinkDeviceId: null,
          deviceLinkDeviceName: null,
          deviceLinkConnectionStatus: null,
          segments: 1,
          sessions: [],
          latestActivityAt: '',
        }}
      />
    ),
});
