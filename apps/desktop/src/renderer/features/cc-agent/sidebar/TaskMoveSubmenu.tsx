import { useEffect, useState, type ReactNode } from 'react';
import { ChevronRight, Monitor } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Session } from '@/lib/ccAgent.types';
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu';
import {
  loadDeviceLinkExistingProjects,
  recentWorkdirsToProjects,
} from '@/components/new-chat/remoteExistingProjects';
import type { FolderPickerOption } from '@/components/new-chat/FolderPickerPopover';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
} from '@/contexts/dataOwnerGeneration';
import { remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';
import { toast } from '@/lib/toast';
import { SessionProjectMoveSubmenu } from './SessionProjectMoveSubmenu';
import {
  MENU_ITEM_CLASS,
  MENU_ROW_CLASS,
  MENU_SEPARATOR_CLASS,
  MENU_SUB_CONTENT_CLASS,
} from './menuStyles';

export interface TaskMoveDestination {
  deviceId: string;
  deviceName: string;
  isSelf?: boolean;
  project: string | null;
}

/** Same source-host business operation for recent projects, dialogue, and the folder picker. */
export async function moveRemoteTaskProject(session: Session, workingDir: string | null) {
  const device = session.deviceLinkDeviceId;
  if (!device) throw new Error('MIGRATION_FAILED');
  const owner = getDataOwnerGeneration();
  const result = await window.electronAPI.deviceLink
    .taskMigration(device, {
      action: 'move-project',
      sessionId: session.id,
      workingDir,
    })
    .catch((error) => {
      if (String(error).includes('MIGRATION_INVALID_REQUEST'))
        throw new Error('MIGRATION_UNSUPPORTED');
      throw error;
    });
  if (!isDataOwnerGenerationCurrent(owner)) return;
  if (result.projectMove?.sessionId !== session.id) throw new Error('MIGRATION_FAILED');
  // Refresh through the existing remote projection, retaining its push-vs-read race guard.
  const valid = remoteProjectsStore.captureSessionRead(device, session.id);
  const row = (await window.electronAPI.deviceLink.invoke(device, 'local-db:sessions:get', [
    session.id,
  ])) as Session;
  if (!isDataOwnerGenerationCurrent(owner) || !valid()) return;
  if (row?.id !== session.id) throw new Error('MIGRATION_FAILED');
  remoteProjectsStore.mergeDeviceSessions(
    device,
    remoteProjectsStore.getDeviceName(device) ?? device,
    [valid.mergeActivity(row)],
  );
}

export function TaskMoveSubmenu({
  session,
  disabled,
  localProjects,
  onMigration,
  onBrowseRemote,
}: {
  session: Session;
  disabled: boolean;
  localProjects: ReactNode;
  onMigration(destination: TaskMoveDestination): void;
  onBrowseRemote(): void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [devices, setDevices] = useState<DeviceLinkDeviceView[]>([]);
  const [projects, setProjects] = useState<FolderPickerOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [deviceError, setDeviceError] = useState(false);
  const [projectError, setProjectError] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!open) return;
    let disposed = false;
    const owner = getDataOwnerGeneration();
    const current = () => !disposed && isDataOwnerGenerationCurrent(owner);
    setLoading(true);
    setProjects([]);
    setDevices([]);
    setDeviceError(false);
    setProjectError(false);
    void Promise.allSettled([
      window.electronAPI.deviceLink
        .listDevices()
        .then((list) => {
          if (current())
            setDevices(
              list.devices.filter(
                (d) =>
                  (session.deviceLinkDeviceId
                    ? d.deviceId !== session.deviceLinkDeviceId
                    : !d.isSelf) &&
                  d.controlEnabled &&
                  !['ios', 'android'].includes(d.platform ?? '') &&
                  d.online && d.remoteControlEnabled,
              ),
            );
        })
        .catch(() => {
          if (current()) setDeviceError(true);
        }),
      session.deviceLinkDeviceId
        ? loadDeviceLinkExistingProjects(session.deviceLinkDeviceId)
            .then((rows) => {
              if (current())
                setProjects(
                  rows
                    .filter((row) => row.exists !== false)
                    .map((row) => ({ ...row, description: row.path })),
                );
            })
            .catch(() => {
              if (current()) setProjectError(true);
            })
        : Promise.resolve(),
    ]).then(() => {
      if (current()) setLoading(false);
    });
    return () => {
      disposed = true;
    };
  }, [open, session.deviceLinkDeviceId, retry]);
  const move = (path: string | null) => {
    const owner = getDataOwnerGeneration();
    void moveRemoteTaskProject(session, path)
      .then(() => {
        if (isDataOwnerGenerationCurrent(owner)) toast.success(t('taskMove.moved'));
      })
      .catch((error) => {
        if (!isDataOwnerGenerationCurrent(owner)) return;
        const code = /MIGRATION_[A-Z_]+/.exec(String(error))?.[0];
        toast.error(t(`taskMigration.errors.${code}`, { defaultValue: t('taskMove.failed') }));
      });
  };
  return (
    <DropdownMenuSub open={open} onOpenChange={setOpen}>
      <DropdownMenuSubTrigger disabled={disabled} className={MENU_ROW_CLASS}>
        <span className="flex-1">{t('ccAgent.sidebar.sessionMenu.moveToProject')}</span>
        <ChevronRight size={14} className="ml-2 shrink-0 text-[var(--cmd-palette-item-meta)]" />
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent
        sideOffset={4}
        className={`${MENU_SUB_CONTENT_CLASS} w-[320px] overflow-hidden`}
      >
        {session.deviceLinkDeviceId ? (
          <>
            {loading && <div className={MENU_ITEM_CLASS}>{t('taskMove.loading')}</div>}
            {projectError && (
              <DropdownMenuItem
                className={MENU_ITEM_CLASS}
                onSelect={(e) => {
                  e.preventDefault();
                  setRetry((n) => n + 1);
                }}
              >
                {t('taskMove.retry')}
              </DropdownMenuItem>
            )}
            <SessionProjectMoveSubmenu
              heading={t('taskMove.sourceProjects')}
              projectOptions={projects}
              currentWorkingDir={session.workspaceKind === 'project' ? session.workingDir : null}
              isDialogue={session.workspaceKind === 'dialogue'}
              onSelectProject={move}
              onBrowseProject={onBrowseRemote}
              onMoveToDialogue={() => move(null)}
            />
          </>
        ) : (
          localProjects
        )}
        {!session.orcaRole && (
          <>
            <DropdownMenuSeparator className={MENU_SEPARATOR_CLASS} />
            <div className="px-3 py-1.5 text-xs text-[var(--cmd-palette-item-meta)]">
              {t('taskMove.otherComputers')}
            </div>
            {deviceError ? (
              <DropdownMenuItem
                className={MENU_ITEM_CLASS}
                onSelect={(e) => {
                  e.preventDefault();
                  setRetry((n) => n + 1);
                }}
              >
                {t('taskMove.retry')}
              </DropdownMenuItem>
            ) : (
              devices.map((device) => (
                <DeviceProjects key={device.deviceId} device={device} onSelect={onMigration} />
              ))
            )}
            {!loading && !deviceError && !devices.length && (
              <div className="px-3 py-2 text-sm text-[var(--cmd-palette-item-meta)]">
                {t('taskMigration.noDevices')}
              </div>
            )}
          </>
        )}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

function DeviceProjects({
  device,
  onSelect,
}: {
  device: DeviceLinkDeviceView;
  onSelect(value: TaskMoveDestination): void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [projects, setProjects] = useState<FolderPickerOption[] | null>(null);
  const [error, setError] = useState<'upgrade' | 'retry' | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!open) return;
    let disposed = false;
    const owner = getDataOwnerGeneration();
    setProjects(null);
    setError(null);
    void window.electronAPI.deviceLink
      .taskMigration(device.isSelf ? null : device.deviceId, { action: 'caps' })
      .then((caps) => {
        if (!disposed && isDataOwnerGenerationCurrent(owner))
          setProjects(
            recentWorkdirsToProjects(
              (caps.projects ?? []).map((path) => ({ path, lastUsedAt: '' })),
            ).map((row) => ({ ...row, description: row.path })),
          );
      })
      .catch((error) => {
        if (!disposed && isDataOwnerGenerationCurrent(owner)) {
          // The host normalizes explicit missing capabilities to MIGRATION_UNSUPPORTED.
          // Connection failures and timeouts do not imply an outdated application.
          setError(/\bMIGRATION_UNSUPPORTED\b/.test(String(error)) ? 'upgrade' : 'retry');
        }
      });
    return () => {
      disposed = true;
    };
  }, [open, device.deviceId, device.isSelf, retry]);
  const choose = (project: string | null) =>
    onSelect({
      deviceId: device.deviceId,
      deviceName: device.name,
      isSelf: device.isSelf,
      project,
    });
  return (
    <DropdownMenuSub open={open} onOpenChange={setOpen}>
      <DropdownMenuSubTrigger disabled={!device.online} className={MENU_ROW_CLASS}>
        <Monitor size={14} className="mr-2 shrink-0" />
        <span className="flex-1 truncate">{device.name}</span>
        {device.isSelf && (
          <span className="ml-2 shrink-0 text-xs text-[var(--cmd-palette-item-meta)]">
            {t('settings.devices.thisDevice')}
          </span>
        )}
        {!device.online ? (
          <span className="ml-2 text-xs">{t('taskMove.offline')}</span>
        ) : (
          <ChevronRight size={14} className="ml-2 shrink-0" />
        )}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent
        sideOffset={4}
        className={`${MENU_SUB_CONTENT_CLASS} w-[320px] overflow-hidden`}
      >
        {error === 'upgrade' ? (
          <div role="status" className="px-3 py-2 text-sm text-[var(--cmd-palette-item-meta)]">
            {t('taskMove.upgradeComputer', { name: device.name })}
          </div>
        ) : error ? (
          <DropdownMenuItem
            className={MENU_ITEM_CLASS}
            onSelect={(e) => {
              e.preventDefault();
              setRetry((n) => n + 1);
            }}
          >
            {t('taskMove.retry')}
          </DropdownMenuItem>
        ) : projects ? (
          <>
            <DropdownMenuItem className={MENU_ITEM_CLASS} onSelect={() => choose(null)}>
              {t('taskMigration.defaultFolder')}
            </DropdownMenuItem>
            <SessionProjectMoveSubmenu
              heading={t('taskMigration.project')}
              projectOptions={projects}
              isDialogue={false}
              onSelectProject={choose}
            />
          </>
        ) : (
          <div className={MENU_ITEM_CLASS}>{t('taskMove.loading')}</div>
        )}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
