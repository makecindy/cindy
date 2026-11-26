/**
 * SessionStatusIcon —— 会话左侧状态图标(vendor mark 同时承担 agent 标识 + 运行/状态指示)。
 * ===========================================================================
 * 从 SessionItem 的 "status zone" 抽出,供「对话列表行(SessionItem)」与「置顶卡片
 * (SessionCard card 变体)」共用同一份逻辑,确保两处**完全一致**:
 *   - archived          → Archive 图标(vendor 已不重要)
 *   - attached(/ctr 接管中)→ RadioTower,优先级高于 running(接管期桌面被动观察)
 *   - orca-lead(协同)   → UsersRound（与「+」菜单协同项同款）
 *   - 其余              → VendorIcon(Claude Code 像素脸 / Codex CLI 花形+`>_`)
 *   running:图标切 Thinking Orange + 呼吸;需关注:右上叠状态点(全端统一色表:
 *   error 红 / awaiting TapTap 蓝 / 完成未读绿,tone 按行精准订阅 attention store);
 *   有未发送内容(草稿/暂停队列)且未选中:右下叠铅笔。
 *   Agent 在另一台电脑运行(任务在本机,或在远程控制的被控电脑上):VendorIcon 右上角加信号
 *   波纹,悬停说明哪台电脑;右上角正显示状态点时由状态点占位,波纹暂不画(两者同角，叠在一起
 *   读不出)。
 * idle 时图标照常显示——让用户一眼看出"这是哪一个 agent"。
 *
 */

import type { ReactNode } from 'react';
import { isSharedTaskPeer, providerSharePickerState } from '@cindy/device-link';
import { Archive, Pencil, RadioTower, UsersRound } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import type { Session } from '@/lib/ccAgent.types';
import { isOrcaLeadSession } from '@/lib/orcaSessionIdentity';
import { useComposerDraftPresence } from '@/hooks/useComposerDraftPresence';
import { useSessionPausedQueue } from '@/hooks/useSessionPausedQueue';
import { useGhostSessionBusy } from '@/cindy-brain/ghostSessionActivityStore';
import { useSessionAttentionKind } from '@/lib/sessionAttentionStore';
import {
  mergeOrcaLeadAttentionKind,
  useOrcaLeadWorkerAttentionKind,
} from '../lib/orcaLeadWorkerAttention';
import { useSessionAttentionUrgency } from '../contexts/SessionAttentionUrgencyContext';
import { AttentionDot } from '@/components/sidebar/AttentionDot';
import {
  VendorIcon,
  engineIconKindOf,
  type EngineIconKind,
} from '@/components/sidebar/VendorIcon';
import { useDeviceLinkDeviceList } from '@/features/device-link/useDeviceLinkDeviceList';
import { useProviderShareReceived } from '@/features/provider-share/providerShareStore';
import { useProviderShareAgentDevices } from '@/features/provider-share/useProviderShareAgentDevices';
import { useOptionalAuthDeviceId } from '@/contexts/AuthContext';
import { usePluginEngineIdentity } from '@/hooks/usePluginEngines';
import { modelCatalogKey } from '../../../../shared/controlledModelCatalog';
import { pluginEngineKeyFromProviderId } from '../../../../shared/pluginEngines';
import {
  isProviderShareAgentDeviceId,
  providerShareIdOfAgentDeviceId,
} from '../../../../shared/providerShare';
import { SidebarRightStatusIndicator } from './SidebarRightStatusIndicator';
import { useCindyMakeActivity } from './useCindyMakeActivity';

/**
 * 插件引擎任务(agent_kind = 'acp')的身份图标：提供该引擎的插件自己的图标(没有则画通用插件引擎
 * 图标)，悬停说明是哪个引擎。单独成组件，只有这类任务的行才订阅引擎列表(共享单例，push 驱动)。
 */
function PluginEngineVendorIcon({
  providerId,
  deviceId,
  readRemote,
  ...iconProps
}: {
  providerId: string | null | undefined;
  /** 引擎所在的电脑(被控电脑，或 Agent 所在的自己另一台电脑)；缺省 = 本机。 */
  deviceId?: string;
  /** False while the remote host is disconnected/connecting: keep cached icon without firing a read. */
  readRemote?: boolean;
  /** 引擎在任务所在电脑之外的另一台电脑上：与远程 Agent 同一个信号波纹。 */
  remote?: boolean;
  size: number;
  running: boolean;
  colorClassName?: string;
}) {
  const selfDeviceId = useOptionalAuthDeviceId();
  // Remote task whose plugin engine runs on THIS computer: read the local list instead of calling ourselves over Device Link.
  const effectiveDeviceId = deviceId && deviceId === selfDeviceId ? undefined : deviceId;
  const { name, iconDataUrl } = usePluginEngineIdentity(providerId, effectiveDeviceId, { readRemote });
  return <VendorIcon {...iconProps} vendor="acp" title={name} {...(iconDataUrl ? { iconDataUrl } : {})} />;
}

/**
 * 别人分享的插件引擎任务(agent_kind = 'acp' 且 agentDeviceId = 'share:<id>')的身份图标：
 * 单独成组件，只有这类行才订阅已收到分享名单，按分享在线/启用状态共用一次共享插件目录读取；
 * 远控场景下若本机权威名单里没有该分享(如仅被控电脑开启了跨区分享)，改经被控电脑的
 * maker:model-catalog:read 读取。
 */
function SharedPluginEngineVendorIcon({
  providerId,
  shareDeviceId,
  taskDeviceId,
  taskDeviceConnected,
  ...iconProps
}: {
  providerId: string | null | undefined;
  shareDeviceId: string;
  /** 任务所在的被控电脑；缺省 = 本机任务。 */
  taskDeviceId?: string;
  taskDeviceConnected: boolean;
  remote?: boolean;
  size: number;
  running: boolean;
  colorClassName?: string;
}) {
  const { received, loaded } = useProviderShareReceived();
  const shareId = providerShareIdOfAgentDeviceId(shareDeviceId);
  const share = shareId ? received.find((entry) => entry.shareId === shareId) : undefined;
  const directReadable = Boolean(
    share
    && providerSharePickerState(share) === 'available'
    && share.hostCapable
    && pluginEngineKeyFromProviderId(share.providerId) !== null,
  );
  const routed = Boolean(taskDeviceId && loaded && !share);
  const effectiveDeviceId = routed ? modelCatalogKey(shareDeviceId, taskDeviceId) : shareDeviceId;
  const readRemote = routed ? taskDeviceConnected : directReadable;
  const { name, iconDataUrl } = usePluginEngineIdentity(providerId, effectiveDeviceId, { readRemote });
  return <VendorIcon {...iconProps} vendor="acp" title={name} {...(iconDataUrl ? { iconDataUrl } : {})} />;
}

/**
 * Agent 在另一台电脑运行的 Agent 图标:带信号波纹，悬停说明在哪台电脑、是否离线。
 * 单独成组件，只有这类任务的行才订阅设备列表(共享单例，push 驱动)。
 */
function AgentDeviceVendorIcon({
  deviceId,
  controlledTask,
  showSignal,
  ...iconProps
}: {
  deviceId: string;
  /**
   * 任务在远程控制的被控电脑上:deviceId 是被控电脑投影的值。分享来的供应商(`share:<id>`)是
   * 被控电脑收到的,本机已收到的分享里查不到它的名字。
   */
  controlledTask: boolean;
  showSignal: boolean;
  vendor: EngineIconKind;
  size: number;
  running: boolean;
  colorClassName?: string;
}) {
  const { t } = useTranslation();
  const device = useDeviceLinkDeviceList()?.find((item) => item.deviceId === deviceId);
  // 分享来的供应商(`share:<id>`)不在同账号设备列表里，本机任务的名字取自已收到的分享。
  const { nameFor: providerShareDeviceName } = useProviderShareAgentDevices();
  const name = device?.name || (controlledTask ? null : providerShareDeviceName(deviceId));
  const offline = device ? !device.online : false;
  return (
    <VendorIcon
      {...iconProps}
      remote={showSignal}
      title={
        name
          ? t(
              offline
                ? 'ccAgent.sessionHeader.agentDeviceOffline'
                : 'ccAgent.sessionHeader.agentDevice',
              { device: name },
            )
          : t('newChat.modelSelector.trigger.agentDeviceUnnamed')
      }
    />
  );
}

export interface SessionStatusIconProps {
  /** Inbox rows use project identity while retaining draft/attention badges. */
  identityIcon?: ReactNode;
  hideHarness?: boolean;
  /** Whether this row already displays activity beside its title or preview. */
  hasSeparateStatusIndicator?: boolean;
  session: Session;
  isRunning: boolean;
  /** /ctr 接管中:图标切 RadioTower。 */
  isAttached: boolean;
  /** 需关注(完成/等待回复/出错):右上叠状态点(tone 由 attention store 决定)。 */
  hasAttentionNotification: boolean;
  /** 当前选中态——选中时不显示"有未发送内容"铅笔(内容就在眼前)。 */
  isActive: boolean;
  /** 主图标像素尺寸。默认沿用各分支既有尺寸(list 变体不变);card 底部 meta 行
   *  传统一值,让状态图标与定时/远程/worktree/时间同一视觉大小。 */
  size?: number;
  /**
   * 是否在图标右上叠 attention 状态点。默认 true(SessionCard 沿用旧行为);
   * SessionItem(sidebar row)传 false —— 状态改由右侧指示器(error 红 / awaiting 蓝 /
   * spinner 橙 / done 绿)承担,左侧只保留 vendor 身份标识,避免左右重复。
   */
  showAttentionDot?: boolean;
  /**
   * attention 点 tone 覆盖。device-link 远程会话的状态不进本地 attention store
   * (镜像在 remoteSessionActivityStore),下方本地 hook 推导会把远程 error/
   * awaiting 一律落成默认绿(kind 缺失按 done)——调用方(rail 置顶瓷砖等)
   * 从远程镜像推导出 tone 时显式传入;不传保持本地推导,零行为变化。
   */
  attentionToneOverride?: 'error' | 'awaiting' | 'done';
}

export function SessionStatusIcon({
  identityIcon,
  hideHarness = false,
  hasSeparateStatusIndicator = false,
  session,
  isRunning: isAgentRunning,
  isAttached,
  hasAttentionNotification,
  isActive,
  size,
  showAttentionDot = true,
  attentionToneOverride,
}: SessionStatusIconProps) {
  const { t } = useTranslation();
  // 意识后台活动(card-action 干活,不经 LLM turn)OR 进呼吸:MJ 按钮点击等
  // fire-and-forget 任务期间用户也能看出"这个会话还有活在跑"。per-row
  // primitive 订阅(性能不变量同下方 attention hooks)。
  const isGhostBusy = useGhostSessionBusy(session.id);
  // Native preparation/builds remain task activity outside an Agent turn,
  // including pinned rail icons that have no row projection.
  const cindyMakeActivity = useCindyMakeActivity(session);
  const isRunning = isAgentRunning || isGhostBusy || cindyMakeActivity != null;
  // 插件引擎任务画通用引擎图标，不回落成 Claude(docs/plans/acp-plugin-bridge.md)。
  const vendor = engineIconKindOf(session.agentKind);
  // Agent 在另一台电脑:任务在本机,或在远程控制的被控电脑上(值由被控电脑投影,null = Agent 就在
  // 被控电脑)。两种都用同一个波纹标识(2026-10-09 用户裁决)。SSH 任务整件在远端，没有这一说。
  const agentDeviceId =
    session.agentDeviceId && !session.remoteHostId ? session.agentDeviceId : null;
  const taskDeviceId = session.deviceLinkDeviceId ?? undefined;
  const isSharedTask = isSharedTaskPeer(taskDeviceId);
  const taskDeviceConnected =
    session.deviceLinkConnectionStatus !== 'disconnected'
    && session.deviceLinkConnectionStatus !== 'connecting';
  const sharedPluginDeviceId =
    !isSharedTask && agentDeviceId && isProviderShareAgentDeviceId(agentDeviceId)
      ? agentDeviceId
      : null;
  const isOrcaLead = isOrcaLeadSession(session);
  const isArchived = session.status === 'archived';
  // 角标 tone:error(含定时任务失败的 urgency context)红 > awaiting 蓝 > 完成未读绿。
  // 两个 hook 都是按 sessionId 的 primitive 精准订阅(性能不变量,见 SessionItem 头注),
  // 本组件也被逐行挂载,禁止退回整表订阅。
  // Orca Lead 另并入其 Worker 的出错 / 等待确认(同为按 id 的 primitive 订阅),
  // 见 lib/orcaLeadWorkerAttention.ts。
  const ownAttentionKind = useSessionAttentionKind(session.id);
  const orcaWorkerAttentionKind = useOrcaLeadWorkerAttentionKind(session.id);
  const attentionKind = mergeOrcaLeadAttentionKind(ownAttentionKind, orcaWorkerAttentionKind);
  const hasAttentionDot = hasAttentionNotification || orcaWorkerAttentionKind !== undefined;
  const isUrgentFromContext = useSessionAttentionUrgency(session.id);
  const attentionTone =
    attentionToneOverride ??
    (isUrgentFromContext || attentionKind === 'error'
      ? 'error'
      : attentionKind === 'awaiting'
        ? 'awaiting'
        : 'done');
  // 有"未发送内容"(输入框草稿 或 被暂停的待发队列)且当前未选中 → 右下铅笔提示。
  const hasDraft = useComposerDraftPresence(session.id);
  const hasPausedQueue = useSessionPausedQueue(session.id);
  const showDraftIndicator = (hasDraft || hasPausedQueue) && !isActive;
  const draftIndicatorLabel = hasDraft
    ? t('ccAgent.sidebar.hasDraft')
    : t('ccAgent.sidebar.hasPausedQueue');

  const hideVendor = hideHarness && !identityIcon && !isArchived && !isOrcaLead && !isAttached;
  const showRunningIndicator = hideVendor && !hasSeparateStatusIndicator && isRunning;
  if (hideVendor && !showRunningIndicator && !showDraftIndicator && !(showAttentionDot && hasAttentionDot)) return null;

  return (
    <span className={cn("relative shrink-0 inline-flex items-center justify-center", identityIcon ? "size-[18px]" : "size-3")} aria-hidden={showRunningIndicator ? undefined : true}>
      {identityIcon ?? (isArchived ? (
        <Archive
          size={size ?? 12}
          strokeWidth={1.75}
          className={
            isActive
              ? 'text-[var(--sidebar-item-active-foreground)]'
              : 'text-[var(--cmd-palette-item-meta)]'
          }
        />
      ) : isOrcaLead ? (
        // 常驻呼吸动画挂 HTML wrapper,SVG 保持静态(AGENTS 规则 7 SVG 动画红线,PR#226 review)
        <span
          className={cn(
            'inline-flex shrink-0',
            // 用户拍板 2026-07-20:running 橙优先于选中态反相前景
            isRunning
              ? 'text-[var(--status-bar-accent)]'
              : isActive
                ? 'text-[var(--sidebar-item-active-foreground)]'
                : 'text-[var(--cmd-palette-item-meta)]',
            isRunning && 'session-status-breathing',
          )}
        >
          <UsersRound size={size ?? 13} strokeWidth={1.75} className="shrink-0" />
        </span>
      ) : isAttached ? (
        // 常驻呼吸动画挂 HTML wrapper,SVG 保持静态(AGENTS 规则 7 SVG 动画红线,PR#226 review)
        <span
          className={cn(
            'inline-flex shrink-0',
            // 用户拍板 2026-07-20:running 橙优先于选中态反相前景
            isRunning
              ? 'text-[var(--status-bar-accent)]'
              : isActive
                ? 'text-[var(--sidebar-item-active-foreground)]'
                : 'text-[var(--cmd-palette-item-meta)]',
            isRunning && 'session-status-breathing',
          )}
        >
          <RadioTower size={size ?? 12} strokeWidth={1.75} className="shrink-0" />
        </span>
      ) : hideVendor ? null : vendor === 'acp' ? (
        sharedPluginDeviceId ? (
          <SharedPluginEngineVendorIcon
            providerId={session.providerId}
            shareDeviceId={sharedPluginDeviceId}
            taskDeviceId={taskDeviceId}
            taskDeviceConnected={taskDeviceConnected}
            remote={!(showAttentionDot && hasAttentionDot)}
            size={size ?? 12}
            running={isRunning}
            colorClassName={isActive ? 'text-[var(--sidebar-item-active-foreground)]' : undefined}
          />
        ) : (
          <PluginEngineVendorIcon
            providerId={session.providerId}
            // 共享任务保持 fail-closed，不读本机或第三方插件目录；
            // 引擎在自己的另一台电脑上(Agent 在那台，任务在这台)时，名称与图标读那台的列表。
            deviceId={isSharedTask ? taskDeviceId : (agentDeviceId ?? taskDeviceId)}
            readRemote={isSharedTask ? false : (agentDeviceId ? true : taskDeviceConnected)}
            remote={!!agentDeviceId && !(showAttentionDot && hasAttentionDot)}
            size={size ?? 12}
            running={isRunning}
            colorClassName={isActive ? 'text-[var(--sidebar-item-active-foreground)]' : undefined}
          />
        )
      ) : agentDeviceId ? (
        <AgentDeviceVendorIcon
          deviceId={agentDeviceId}
          controlledTask={Boolean(session.deviceLinkDeviceId)}
          showSignal={!(showAttentionDot && hasAttentionDot)}
          vendor={vendor}
          size={size ?? (vendor === 'cc' ? 13 : 12)}
          running={isRunning}
          colorClassName={isActive ? 'text-[var(--sidebar-item-active-foreground)]' : undefined}
        />
      ) : (
        <VendorIcon
          vendor={vendor}
          size={size ?? (vendor === 'cc' ? 13 : 12)}
          running={isRunning}
          colorClassName={isActive ? 'text-[var(--sidebar-item-active-foreground)]' : undefined}
        />
      ))}
      {showRunningIndicator && (
        <SidebarRightStatusIndicator kind="running" isActive={isActive} className="size-3" />
      )}
      {showAttentionDot && hasAttentionDot && (
        <AttentionDot size={6} tone={attentionTone} className="absolute -top-0.5 -right-0.5" />
      )}
      {showDraftIndicator && (
        <span
          className="absolute -bottom-0.5 -right-0.5 text-[var(--sidebar-draft-indicator)]"
          aria-label={draftIndicatorLabel}
          title={draftIndicatorLabel}
          role="img"
        >
          <Pencil size={8} strokeWidth={2.25} aria-hidden />
        </span>
      )}
    </span>
  );
}
