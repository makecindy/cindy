import { useEffect, useState, type ReactNode } from 'react';
import { MonitorSmartphone, ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { DeviceSectionHeader } from '../../../src/renderer/features/cc-agent/sidebar/DeviceSectionHeader';
import { SessionProjectSettingsButton } from '../../../src/renderer/features/cc-agent/sidebar/SessionProjectSettingsButton';
import type { Session } from '../../../src/renderer/lib/ccAgent.types';
import { ctx as page, mountPage, subscription } from '../../ui-page/harness';
import { ProjectSettingsDialog } from '../../../src/renderer/features/cc-agent/sidebar/ProjectSettingsDialog';
import { setDataOwnerGeneration } from '../../../src/renderer/contexts/dataOwnerGeneration';
import { recentWorkdirsStore } from '../../../src/renderer/lib/recentWorkdirsStore';
// This isolated HTTP fixture lacks secure-context UUID support. Production uses Chromium's crypto.
if (!crypto.randomUUID) {
  let sequence = 0;
  crypto.randomUUID = () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`;
}
setDataOwnerGeneration('fixture', 1);
// Only the intro case starts as someone who has no project yet and has not seen the introduction.
if (page.case !== 'intro') localStorage.setItem('featureIntro.project.seen', '1');
const writes: unknown[] = [];
const pickerScopes: unknown[] = [];
Object.assign(window, { projectSettingsWrites: writes, projectPickerScopes: pickerScopes });
function DeviceEntry({ enabled, children }: { enabled: boolean; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const { t } = useTranslation();
  // The sidebar keeps this computer's project list loaded; the introduction reads it.
  useEffect(() => {
    if (page.case === 'intro') void recentWorkdirsStore.ensure();
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
      <DeviceEntry enabled={ctx.case === 'create-device' || ctx.case === 'intro'}>
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
