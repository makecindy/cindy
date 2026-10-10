/**
 * 消息气泡上方的来源标签行；群内显式私聊的 assistant 消息复用同一行。
 *
 * 两个独立维度（与 @cindy/maker-shared/message-source 同口径）：
 *  - 谁发的（至多一个）：自动化 / 其他任务 / 伙伴 / Orca 发送方 / Hook 渠道 / 插件；
 *  - 在哪台设备上发的：手机或另一台电脑远程操作本机时由被控端盖章（sourceDevice）。
 *    查看者就是发送设备时不标；被控电脑本机输入本来就没有设备章。
 * 本机用户亲手输入两者都没有，整行不渲染（`empty:hidden`，不占 flex 间距）。
 * 整行属于来源标注，分享图不带（SHARE_SOURCE_ATTR）。
 */

import { Monitor, Puzzle, Smartphone, Users } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { useOptionalAuthDeviceId } from '@/contexts/AuthContext';
import { useSessionNavigationMode } from '@/features/cc-agent/embeddedSessionNavigation';
import { useDeviceLinkDeviceList } from '@/features/device-link/useDeviceLinkDeviceList';
import { getStickySessionDeviceId } from '@/features/device-link/stickySessionOrigin';
import type { MessageAutomationOrigin } from '@/lib/ccAgent.types';
import {
  joinSourceTooltip,
  myDevicesFocusPath,
  resolveSourceDeviceDisplay,
  shouldShowSourceDeviceForViewer,
} from '@/lib/messageSourceLabel';
import { SHARE_SOURCE_ATTR } from '@/lib/shareConversationImage';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import type { MessageSourceDevice, MessageSourcePlugin, MessageSourceGroup } from '@cindy/maker-shared/message-source';

import { AutomationOriginBadge, MessageSourceLabelShell } from './AutomationOriginBadge';

/**
 * 发送设备标签：「从手机「名字」发送」/「从电脑「名字」发送」。点击跳到设置 → 远程控制 →
 * 我的设备并聚焦该设备；设备已不在列表时提示已移除、不跳转。embedded 视图只展示。
 */
export function MessageSourceDeviceBadge({ device }: { device: MessageSourceDevice }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const navigationMode = useSessionNavigationMode();
  const authDeviceId = useOptionalAuthDeviceId();
  const devices = useDeviceLinkDeviceList();
  if (!shouldShowSourceDeviceForViewer(device, { authDeviceId, devices })) return null;

  const display = resolveSourceDeviceDisplay(device, devices);
  const mobile = device.platform === 'mobile';
  const label = display.name
    ? t(
        mobile
          ? 'chat.userMessage.deviceSentMobileNamed'
          : 'chat.userMessage.deviceSentDesktopNamed',
        {
          name: display.name,
        },
      )
    : t(mobile ? 'chat.userMessage.deviceSentMobile' : 'chat.userMessage.deviceSentDesktop');
  const interactive = navigationMode !== 'sidebar-embedded';
  const Icon = mobile ? Smartphone : Monitor;
  return (
    <MessageSourceLabelShell
      kind="device"
      icon={<Icon size={11} strokeWidth={1.75} aria-hidden className="shrink-0" />}
      label={label}
      tooltip={joinSourceTooltip([
        interactive && t('chat.userMessage.deviceViewSettings'),
        t('chat.userMessage.sourceIds.device', { id: device.deviceId }),
      ])}
      onOpen={
        interactive
          ? () => {
              if (display.present === false) {
                toast.info(t('chat.userMessage.deviceRemoved'));
                return;
              }
              navigate(myDevicesFocusPath(device.deviceId));
            }
          : null
      }
    />
  );
}

/**
 * 排队面板的紧凑设备标记（图标 + 设备名，悬停给出完整来源与设备 ID）。规则同
 * MessageSourceDeviceBadge：查看者就是发送设备时不显示。排队行是单行紧凑布局，只展示、不跳转；
 * 本人排队消息仍可编辑 / 插话，标记不改变这一点。
 */
export function QueueSourceDeviceTag({ device }: { device: MessageSourceDevice }) {
  const { t } = useTranslation();
  const authDeviceId = useOptionalAuthDeviceId();
  const devices = useDeviceLinkDeviceList();
  if (!shouldShowSourceDeviceForViewer(device, { authDeviceId, devices })) return null;
  const display = resolveSourceDeviceDisplay(device, devices);
  const mobile = device.platform === 'mobile';
  const label = display.name
    ? t(mobile ? 'chat.userMessage.deviceSentMobileNamed' : 'chat.userMessage.deviceSentDesktopNamed', {
        name: display.name,
      })
    : t(mobile ? 'chat.userMessage.deviceSentMobile' : 'chat.userMessage.deviceSentDesktop');
  const Icon = mobile ? Smartphone : Monitor;
  return (
    <span
      aria-label={label}
      className="relative top-px inline-flex min-w-0 max-w-[120px] shrink-0 items-center gap-1 text-12 leading-[1.25] text-[var(--text-secondary)]"
      title={joinSourceTooltip([label, t('chat.userMessage.sourceIds.device', { id: device.deviceId })])}
    >
      <Icon size={11} strokeWidth={1.75} aria-hidden className="shrink-0" />
      <span className="truncate">{display.name ?? label}</span>
    </span>
  );
}

/**
 * 插件标签：「由插件「名字」发送」。点击打开本机插件详情；远程任务的插件装在那台设备上，
 * 本机同 id 详情不对应，embedded 视图也不拥有路由，两者都只展示。
 */
export function MessageSourcePluginBadge({
  plugin,
  hostSessionId,
}: {
  plugin: MessageSourcePlugin;
  hostSessionId?: string;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const navigationMode = useSessionNavigationMode();
  const remote = Boolean(getStickySessionDeviceId(hostSessionId));
  const interactive = navigationMode !== 'sidebar-embedded' && !remote;
  return (
    <MessageSourceLabelShell
      kind="plugin"
      icon={<Puzzle size={11} strokeWidth={1.75} aria-hidden className="shrink-0" />}
      label={
        plugin.name
          ? t('chat.userMessage.pluginSentNamed', { name: plugin.name })
          : t('chat.userMessage.pluginSent')
      }
      tooltip={joinSourceTooltip([
        interactive && t('chat.userMessage.pluginViewDetail'),
        t('chat.userMessage.sourceIds.plugin', { id: plugin.pluginId }),
      ])}
      onOpen={
        interactive ? () => navigate(`/plugins?ghost=${encodeURIComponent(plugin.pluginId)}`) : null
      }
    />
  );
}

export function MessageSourceLabels({
  automationOrigin,
  hookIm,
  sourceDevice,
  sourcePlugin,
  sourceGroup,
  hostSessionId,
  align = 'end',
}: {
  automationOrigin?: MessageAutomationOrigin;
  hookIm?: string;
  sourceDevice?: MessageSourceDevice;
  sourcePlugin?: MessageSourcePlugin;
  sourceGroup?: MessageSourceGroup;
  hostSessionId?: string;
  align?: 'start' | 'end';
}) {
  if (!automationOrigin && !sourceDevice && !sourcePlugin && !sourceGroup) return null;
  return (
    <div
      {...{ [SHARE_SOURCE_ATTR]: '' }}
      data-message-source-labels=""
      className={cn(
        'flex max-w-full flex-wrap items-center gap-x-3 gap-y-0.5 empty:hidden',
        align === 'start' ? 'justify-start' : 'justify-end',
      )}
    >
      {/* 群来源仅用于显式私聊；普通发送方仍以插件优先于其运行任务。 */}
      {sourceGroup ? (
        <MessageSourceGroupBadge group={sourceGroup} />
      ) : sourcePlugin ? (
        <MessageSourcePluginBadge plugin={sourcePlugin} hostSessionId={hostSessionId} />
      ) : automationOrigin ? (
        <AutomationOriginBadge
          automationOrigin={automationOrigin}
          hostSessionId={hostSessionId}
          hookIm={hookIm}
        />
      ) : null}
      {sourceDevice ? <MessageSourceDeviceBadge device={sourceDevice} /> : null}
    </div>
  );
}

function MessageSourceGroupBadge({ group }: { group: MessageSourceGroup }) {
  const { t } = useTranslation();
  return <MessageSourceLabelShell
    kind="group"
    icon={<Users size={11} strokeWidth={1.75} aria-hidden className="shrink-0" />}
    label={group.name ? t('chat.userMessage.groupSentNamed', { name: group.name }) : t('chat.userMessage.groupSent')}
    tooltip={t('chat.userMessage.sourceIds.group', { id: group.groupId })}
  />;
}
