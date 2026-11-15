import { SessionProjectSettingsButton } from '../../../src/renderer/features/cc-agent/sidebar/SessionProjectSettingsButton';
import type { Session } from '../../../src/renderer/lib/ccAgent.types';
import { mountPage, subscription } from '../../ui-page/harness';
import { ProjectSettingsDialog } from '../../../src/renderer/features/cc-agent/sidebar/ProjectSettingsDialog';
import { setDataOwnerGeneration } from '../../../src/renderer/contexts/dataOwnerGeneration';
setDataOwnerGeneration('fixture', 1);
const writes: unknown[] = [];
Object.assign(window, { projectSettingsWrites: writes });
mountPage({
  host: (ctx) => ({
    showOpenDirectoryDialog: async () => ({ canceled: false, path: '/Projects/Reference' }),
    localDb: {
      projectAliases: {
        snapshot: async () => ({
          aliases: [{ projectKey: 'local:/Projects/Cindy', alias: 'Cindy' }],
          icons: ctx.data.automatic ? {} : { 'local:/Projects/Cindy': '🚀' },
          platform: 'darwin',
          settingsSupported: true,
          settingsVersion: ctx.data.version ?? 6,
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
          return {};
        },
      },
    },
  }),
  render: (ctx) =>
    ctx.data.header ? (
      <div className="flex items-center p-6">
        <SessionProjectSettingsButton
          session={
            {
              id: 'header-task',
              workspaceKind: 'project',
              workingDir: '/Projects/Cindy/.worktrees/task',
              projectDir: '/Projects/Cindy',
              updatedAt: '',
            } as Session
          }
        />
        <span>Task in a worktree</span>
      </div>
    ) : (
      <ProjectSettingsDialog
        create={!!ctx.data.create}
        onClose={() => {}}
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
      />
    ),
});
