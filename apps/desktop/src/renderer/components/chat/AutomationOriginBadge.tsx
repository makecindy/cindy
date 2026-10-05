import { useSyncExternalStore, type ReactNode } from 'react';
import { MessageSquare, Send, Timer } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { BotAvatar } from '@/features/bots/BotAvatar';
import { useBotProfiles } from '@/features/bots/botStore';
import { useSessionNavigationMode } from '@/features/cc-agent/embeddedSessionNavigation';
import {
  remoteProjectsStore,
  useRemoteSessionTitle,
} from '@/features/device-link/remoteProjectsStore';
import { getStickySessionDeviceId } from '@/features/device-link/stickySessionOrigin';
import { scheduleFocusPath } from '@/features/scheduler/lib/scheduleSessionBinding';
import type { MessageAutomationOrigin } from '@/lib/ccAgent.types';
import {
  hookConnectionNameFromOrigin,
  isHookSchedulerOrigin,
} from '@/lib/messageAutomationOrigin';
import { joinSourceTooltip } from '@/lib/messageSourceLabel';
import { sessionsStore } from '@/lib/sessionsStore';
import { cn } from '@/lib/utils';

import { imLabel } from './HookTaskCard';

/**
 * 来源任务的实时标题：远程任务查所在设备的任务镜像，本机任务查本机任务列表，
 * 都按 id 索引取值（不随无关任务变化逐条扫描）；拿不到返回 null，由调用方回退快照。
 */
function useLiveSessionTitle(sessionId: string | undefined, remote: boolean): string | null {
  const localTitle = useSyncExternalStore(
    (onChange) => sessionsStore.subscribe(onChange),
    () => (sessionId && !remote ? sessionsStore.getTitleById(sessionId) : null),
  );
  const remoteTitle = useRemoteSessionTitle(remote ? sessionId : undefined);
  return remote ? remoteTitle : localTitle;
}

const sourceLabelClassName =
  'inline-flex max-w-full items-center gap-1 text-11 text-[var(--cmd-palette-item-meta)]';

/**
 * 气泡上方来源标签的统一外壳：可点击时是按钮（悬停变色），否则是静态文字。
 * 悬停提示首行说明点击去向，其后逐行列出对应 id。
 */
export function MessageSourceLabelShell({
  kind,
  icon,
  label,
  tooltip,
  onOpen,
}: {
  kind: string;
  icon: ReactNode;
  label: string;
  tooltip?: string;
  /** null / undefined：只展示，不可点击（embedded 视图、已脱敏或无去向）。 */
  onOpen?: (() => void) | null;
}) {
  const content = (
    <>
      {icon}
      <span className="min-w-0 truncate">{label}</span>
    </>
  );
  if (!onOpen) {
    return (
      <span data-message-origin={kind} title={tooltip} className={sourceLabelClassName}>
        {content}
      </span>
    );
  }
  return (
    <button
      type="button"
      data-split-pane-route-action=""
      data-message-origin={kind}
      title={tooltip}
      onClick={onOpen}
      className={cn(
        sourceLabelClassName,
        'cursor-pointer hover:text-foreground transition-colors focus:outline-none',
      )}
    >
      {content}
    </button>
  );
}

/** 这条来源是否会出标签（Orca 来源只在记下发送方任务时出）。 */
export function hasAutomationOriginBadge(origin: MessageAutomationOrigin): boolean {
  return !(origin.kind === 'session' && origin.orca && !origin.senderSessionId);
}

/**
 * 非用户手动输入的消息来源标签：自动化发送的跳自动化页，其他任务经工具发送的
 * 跳来源任务。embedded 会话中只展示身份，不拥有跳转主窗口路由的能力。
 * Hook 渠道消息复用自动化来源，这里显示渠道（「来自 Slack」），不可点击。
 */
export function AutomationOriginBadge({
  automationOrigin,
  hostSessionId,
  hookIm,
}: {
  automationOrigin: MessageAutomationOrigin;
  /** 标签所在的任务；远程任务据此把来源任务钉到同一台设备再跳转。 */
  hostSessionId?: string;
  /** Hook 消息的 IM 平台（hookSource.im）；有它时渠道名取平台名。 */
  hookIm?: string;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const navigationMode = useSessionNavigationMode();
  const senderSessionId =
    automationOrigin.kind === 'session' ? automationOrigin.senderSessionId : undefined;
  const botProfiles = useBotProfiles();
  // 远程任务的来源任务与伙伴资料都在那台设备上，本机同 id 资料不可信（与 BotDirectMessageCard 同口径）。
  // 粘滞归属：relay 瞬时重连会清空镜像索引，此窗口内仍要把远程任务当远程处理，
  // 否则来源任务会被当成本机任务打开。
  const hostDeviceId = getStickySessionDeviceId(hostSessionId);
  const liveSenderTitle = useLiveSessionTitle(senderSessionId, Boolean(hostDeviceId));
  const senderBot =
    automationOrigin.kind === 'session' && automationOrigin.senderBotId
      ? (() => {
          const profile = hostDeviceId
            ? undefined
            : botProfiles.find((item) => item.id === automationOrigin.senderBotId);
          return {
            name: profile?.name || automationOrigin.senderBotName || automationOrigin.senderBotId,
            avatar: profile?.avatar ?? null,
            avatarColor: profile?.avatarColor ?? null,
          };
        })()
      : null;

  if (!hasAutomationOriginBadge(automationOrigin)) return null;

  if (automationOrigin.kind === 'scheduler' && isHookSchedulerOrigin(automationOrigin)) {
    const channel = hookIm ? imLabel(hookIm, t) : hookConnectionNameFromOrigin(automationOrigin);
    return (
      <MessageSourceLabelShell
        kind="hook"
        icon={<MessageSquare size={11} strokeWidth={1.75} aria-hidden className="shrink-0" />}
        label={t('chat.userMessage.hookChannelFrom', { channel: channel ?? 'Hook' })}
      />
    );
  }

  let label: string;
  let viewTitle: string;
  const idLines: string[] = [];
  // null：来源身份已被主机脱敏（共享任务访客），只展示不可点击的通用文案。
  let open: (() => void) | null;
  if (automationOrigin.kind === 'session') {
    const targetSessionId = automationOrigin.senderSessionId;
    const senderTitle = liveSenderTitle ?? automationOrigin.senderSessionTitle;
    label = senderBot
      ? t('chat.userMessage.botSentNamed', { name: senderBot.name })
      : senderTitle
        ? t('chat.userMessage.sessionSentNamed', { name: senderTitle })
        : t('chat.userMessage.sessionSent');
    viewTitle = t('chat.userMessage.sessionViewSource');
    if (automationOrigin.senderBotId) {
      idLines.push(t('chat.userMessage.sourceIds.teammate', { id: automationOrigin.senderBotId }));
    }
    if (targetSessionId) {
      idLines.push(t('chat.userMessage.sourceIds.session', { id: targetSessionId }));
    }
    open = targetSessionId
      ? () => {
          // 工具只能在同一台设备的任务之间投递：远程任务的来源任务也在那台设备上。
          if (hostDeviceId) remoteProjectsStore.pinSessionOrigin(hostDeviceId, targetSessionId);
          navigate(`/cc-agent/${encodeURIComponent(targetSessionId)}`);
        }
      : null;
  } else {
    const scheduleId = automationOrigin.scheduleId?.trim();
    label = automationOrigin.scheduleName
      ? t('chat.userMessage.automationSentNamed', { name: automationOrigin.scheduleName })
      : t('chat.userMessage.automationSent');
    viewTitle = t('chat.userMessage.automationViewTask');
    if (scheduleId) {
      idLines.push(t('chat.userMessage.sourceIds.automation', { id: scheduleId }));
    }
    // 共享任务访客收到的自动化来源已脱敏（无 id）：没有可跳转的自动化条目。
    open = scheduleId ? () => navigate(scheduleFocusPath(scheduleId)) : null;
  }

  const Icon = automationOrigin.kind === 'session' ? Send : Timer;
  const interactive = navigationMode !== 'sidebar-embedded' && open !== null;
  return (
    <MessageSourceLabelShell
      kind={senderBot ? 'bot' : automationOrigin.kind}
      icon={
        senderBot ? (
          <BotAvatar bot={senderBot} size="xs" className="h-3.5 w-3.5 text-10" />
        ) : (
          <Icon size={11} strokeWidth={1.75} aria-hidden className="shrink-0" />
        )
      }
      label={label}
      tooltip={joinSourceTooltip([interactive && viewTitle, ...idLines])}
      onOpen={interactive ? open : null}
    />
  );
}
