/**
 * 电脑范围切换(device-link 跨设备远程控制)。
 * ---------------------------------------------------------------------------
 * 2026-11-19 用户裁决:侧栏改为顶部横向标签后,原「全部任务 ▾」范围下拉与竖向的
 * 设备分组段合并成一行横向电脑标签 —— 全部 · 本机 · 各台远程电脑。只要有可展示的
 * 远程电脑就出现;只有本机时整行不画,单机用户看不到设备概念。
 * 2026-11-20 用户裁决(「子设备太显眼」「不在线的没隐藏」「要和底下的 session 联系」):
 *   - 只是一行灰色小字，不画胶囊底;当前选中的字变深变粗;
 *   - 只列在线、且在当前标签下真有内容的电脑;当前选中的那台始终保留，方便切回;
 *   - 能切换的电脑不足两台(且没有选中某台)时整行不画。
 *
 * 选择语义沿用 selectedMachineStore 的多选模型(2026-07 定稿):
 *   - 点「全部」→ 回到默认(本机 + 全部远程);
 *   - 点本机 / 某台电脑 → 单选切换;
 *   - Cmd(mac)/ Ctrl(win)+ 点击 → 追加或取消勾选(勾满自动收敛回「全部」,
 *     取消到空回落「全部」),键盘同样用修饰键 + Enter / Space。
 * 设备三态:连接中 → 文字闪耀，仍可选;被拒 → 置灰，点击只提示。
 *
 * 远程入口(原下拉菜单与设备段头上的):
 *   - 右键电脑标签 → 远程桌面 / 在这台电脑新建项目;
 *   - 选中单台远程电脑时，行尾悬停出现远程桌面与新建项目按钮(DeviceSectionHeader);
 *   - 标签行右侧选项菜单 → 远程桌面 ▸ / 远程连接设置(MachineSettingsMenuItems)。
 * 远程任务 bootstrap 读取中在本行行尾转一个灰色小圈(列表本身不插 loading 行)。
 */

import { useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { FolderPlus, Loader2, Monitor, MonitorCog } from 'lucide-react';
import { useMatch, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { useActiveMainView } from '@/hooks/useActiveMainView';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from '@/components/ui/dropdown-menu';
import { useDeviceLinkDeviceList } from '@/features/device-link/useDeviceLinkDeviceList';
import { isMobilePlatform } from '@cindy/maker-shared/device-list';
import {
  isMachineSelected,
  MACHINE_ALL,
  MACHINE_LOCAL,
} from '@/features/device-link/selectedMachineStore';
import {
  useMachineSwitcher,
  useRemoteSessionBootstrapLoading,
} from '@/features/device-link/useMachineSwitcher';
import { DeviceSectionHeader } from './DeviceSectionHeader';
import { useHorizontalScrollFade } from './useHorizontalScrollFade';
import { MENU_ITEM_CLASS, MENU_ROW_CLASS } from './menuStyles';

function useDesktopTargets() {
  return (useDeviceLinkDeviceList() ?? []).filter(
    (device) => !device.isSelf && !isMobilePlatform(device.platform),
  );
}

function openRemoteDesktop(deviceId: string, name: string, errorText: string): void {
  void window.electronAPI
    .openRemoteDesktop({ deviceId, name })
    .catch(() => toast.error(errorText));
}

/** 选项菜单里的远程项:远程桌面 ▸ 各台电脑、远程连接设置。 */
export function MachineSettingsMenuItems(): ReactNode {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const desktopTargets = useDesktopTargets();
  return (
    <>
      {desktopTargets.length > 0 && (
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className={MENU_ROW_CLASS}>
            <Monitor size={14} />
            <span>{t('remoteDesktop.title')}</span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {desktopTargets.map((device) => (
              <DropdownMenuItem
                key={device.deviceId}
                className={MENU_ITEM_CLASS}
                disabled={!device.online || !device.remoteControlEnabled || !device.controlEnabled}
                onSelect={() =>
                  openRemoteDesktop(device.deviceId, device.name, t('remoteDesktop.connectionError'))
                }
              >
                <span>{device.name}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      )}
      <DropdownMenuItem
        className={MENU_ITEM_CLASS}
        onSelect={() => navigate('/settings?tab=remote-control')}
      >
        <MonitorCog size={14} strokeWidth={2} className="shrink-0 opacity-70" />
        <span className="truncate">{t('ccAgent.sidebar.machineSwitcher.remoteSettings')}</span>
      </DropdownMenuItem>
    </>
  );
}

export type MachineProjectTarget = { deviceId: string; deviceName: string } | null;

interface MachineChip {
  id: string;
  label: string;
  selected: boolean;
  connecting?: boolean;
  rejected?: boolean;
  /** 本机 = null;「全部」没有远程动作。 */
  target?: MachineProjectTarget;
  online?: boolean;
}

const CHIP_CLASS =
  'relative flex h-6 shrink-0 items-center rounded-md text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]';
const CHIP_SELECTED_CLASS = 'font-medium text-[var(--sidebar-nav-text)]';
const CHIP_IDLE_CLASS =
  'font-normal text-[var(--sidebar-list-muted)] hover:text-[var(--sidebar-nav-text)]';

/** 横向电脑标签;没有可展示的远程电脑时返回 null。 */
export function MachineTabStrip({
  machinesWithContent,
  onCreateProject,
  trailing,
}: {
  /** 当前标签下有内容的电脑(MACHINE_LOCAL 或 deviceId),不受当前电脑选择影响。 */
  machinesWithContent: ReadonlySet<string>;
  onCreateProject?: (target: MachineProjectTarget) => void;
  /** 行尾悬停动作。 */
  trailing?: ReactNode;
}): ReactNode {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { devices, selectedDeviceId, select, toggle } = useMachineSwitcher();
  const desktopTargets = useDesktopTargets();
  const loading = useRemoteSessionBootstrapLoading(selectedDeviceId);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const modifierRef = useRef(false);
  // 电脑多时同样横向滑动;选中的电脑(哪怕已离线)滑进可见区。
  const [stripRef, fadeStyle] = useHorizontalScrollFade(JSON.stringify(selectedDeviceId), '[aria-pressed="true"]');
  // 选电脑后让过滤结果可见:设置页等非会话视图切回会话视图，文件浏览退回对话。
  const { navigateToView } = useActiveMainView();
  const docBrowseMatch = useMatch('/cc-agent/files/:sessionId');
  const ensureConversationListVisible = () => {
    const docSessionId = docBrowseMatch?.params.sessionId;
    if (docSessionId) {
      navigate(`/cc-agent/${docSessionId}`);
      return;
    }
    navigateToView('cc-agent');
  };

  if (devices.length === 0) return null;

  const isSelected = (id: string) =>
    selectedDeviceId !== MACHINE_ALL && isMachineSelected(selectedDeviceId, id);
  const machineChips: MachineChip[] = [
    {
      id: MACHINE_LOCAL,
      label: t('ccAgent.sidebar.machineSwitcher.localMachine'),
      selected: isSelected(MACHINE_LOCAL),
      target: null,
      online: true,
    },
    ...devices.map((device) => ({
      id: device.deviceId,
      label: device.name,
      selected: isSelected(device.deviceId),
      connecting: device.online && device.status === 'connecting',
      rejected: device.status === 'rejected',
      target: { deviceId: device.deviceId, deviceName: device.name },
      online: device.online && device.status !== 'rejected',
    })),
  ].filter((chip) => chip.selected || (chip.online && machinesWithContent.has(chip.id)));
  // 不足两台可切换、也没有选中某台时，这一行没有意义。
  if (machineChips.length < 2 && selectedDeviceId === MACHINE_ALL) return null;
  const chips: MachineChip[] = [
    {
      id: MACHINE_ALL,
      label: t('ccAgent.sidebar.machineSwitcher.allMachines'),
      selected: selectedDeviceId === MACHINE_ALL,
    },
    ...machineChips,
  ];

  const activate = (chip: MachineChip, withModifier: boolean) => {
    if (chip.rejected) {
      toast.warning(t('settings.remoteControl.accessRevokedByPeer'));
      return;
    }
    if (chip.id === MACHINE_ALL) select(MACHINE_ALL);
    else if (withModifier) toggle(chip.id);
    else select([chip.id]);
    ensureConversationListVisible();
  };

  // 选中单台远程电脑时，行尾悬停给出这台电脑的远程桌面与新建项目。
  const singleRemote =
    selectedDeviceId !== MACHINE_ALL &&
    selectedDeviceId.length === 1 &&
    selectedDeviceId[0] !== MACHINE_LOCAL
      ? chips.find((chip) => chip.id === selectedDeviceId[0])
      : undefined;

  return (
    <DeviceSectionHeader
      deviceId={singleRemote?.target?.deviceId ?? null}
      name={singleRemote?.label ?? ''}
      onCreateProject={
        singleRemote && onCreateProject ? () => onCreateProject(singleRemote.target ?? null) : undefined
      }
      createProjectDisabled={singleRemote?.online === false}
    >
      <div
        ref={stripRef}
        role="toolbar"
        aria-label={t('ccAgent.sidebar.mainTabs.computers')}
        style={fadeStyle}
        aria-busy={loading || undefined}
        className="flex min-w-0 flex-1 items-center gap-3 overflow-x-auto pl-6 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {chips.map((chip) => {
          const desktop = chip.target
            ? desktopTargets.find((device) => device.deviceId === chip.target?.deviceId)
            : undefined;
          const hasMenu = chip.id !== MACHINE_ALL && !chip.rejected;
          return (
            <span key={chip.id} className="relative flex shrink-0">
              <button
                type="button"
                aria-pressed={chip.selected}
                title={chip.id !== MACHINE_ALL ? t('ccAgent.sidebar.machineSwitcher.multiSelect') : undefined}
                className={cn(
                  CHIP_CLASS,
                  chip.selected ? CHIP_SELECTED_CLASS : CHIP_IDLE_CLASS,
                  chip.rejected && 'opacity-50',
                )}
                onClick={(event: MouseEvent) => {
                  const withModifier = event.metaKey || event.ctrlKey || modifierRef.current;
                  modifierRef.current = false;
                  activate(chip, withModifier);
                }}
                onKeyDown={(event: KeyboardEvent) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    modifierRef.current = event.metaKey || event.ctrlKey;
                  }
                  if (hasMenu && (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) {
                    event.preventDefault();
                    setMenuFor(chip.id);
                  }
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  if (hasMenu) setMenuFor(chip.id);
                }}
              >
                <span className={cn('max-w-[10rem] truncate', chip.connecting && 'animate-pulse')}>
                  {chip.label}
                </span>
              </button>
              {hasMenu && (
                <DropdownMenu
                  modal={false}
                  open={menuFor === chip.id}
                  onOpenChange={(open) => setMenuFor(open ? chip.id : null)}
                >
                  <DropdownMenuTrigger asChild>
                    <span aria-hidden className="pointer-events-none absolute inset-0" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent side="bottom" align="start" sideOffset={4} className="min-w-44">
                    {chip.target && (
                      <DropdownMenuItem
                        className={MENU_ITEM_CLASS}
                        disabled={
                          !desktop || !desktop.online || !desktop.remoteControlEnabled || !desktop.controlEnabled
                        }
                        onSelect={() =>
                          openRemoteDesktop(
                            chip.target!.deviceId,
                            chip.label,
                            t('remoteDesktop.connectionError'),
                          )
                        }
                      >
                        <Monitor size={14} strokeWidth={2} className="shrink-0 opacity-70" />
                        <span className="truncate">{t('remoteDesktop.title')}</span>
                      </DropdownMenuItem>
                    )}
                    {onCreateProject && (
                      <DropdownMenuItem
                        className={MENU_ITEM_CLASS}
                        disabled={chip.online === false}
                        onSelect={() => onCreateProject(chip.target ?? null)}
                      >
                        <FolderPlus size={14} strokeWidth={2} className="shrink-0 opacity-70" />
                        <span className="truncate">{t('ccAgent.sidebar.newProject')}</span>
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </span>
          );
        })}
        {loading && (
          <span
            aria-hidden="true"
            className="inline-flex shrink-0 animate-spinner text-[var(--sidebar-list-muted)] motion-reduce:animate-none"
          >
            <Loader2 size={12} strokeWidth={1.8} />
          </span>
        )}
      </div>
      {trailing}
    </DeviceSectionHeader>
  );
}
