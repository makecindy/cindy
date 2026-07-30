/**
 * SessionStatusIcon —— 会话左侧状态图标(vendor mark 同时承担 agent 标识 + 运行/状态指示)。
 * ===========================================================================
 * 从 SessionItem 的 "status zone" 抽出,供「对话列表行(SessionItem)」与「置顶卡片
 * (SessionCard card 变体)」共用同一份逻辑,确保两处**完全一致**:
 *   - archived          → Archive 图标(vendor 已不重要)
 *   - attached(/ctr 接管中)→ RadioTower,优先级高于 running(接管期桌面被动观察)
 *   - orca-lead(协同)   → UsersRound（与右侧栏「协同」pill 同款）
 *   - 其余              → VendorIcon(Claude Code 像素脸 / Codex CLI 花形+`>_`)
 *   running:图标切 Thinking Orange + 呼吸;需关注:右上叠状态点(全端统一色表:
 *   error 红 / awaiting TapTap 蓝 / 完成未读绿,tone 按行精准订阅 attention store);
 *   有未发送内容(草稿/暂停队列)且未选中:右下叠铅笔。
 * idle 时图标照常显示——让用户一眼看出"这是哪一个 agent"。
 *
 */

import { Archive, Pencil, RadioTower, UsersRound } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import type { Session } from '@/lib/ccAgent.types';
import { isOrcaLeadSession } from '@/lib/orcaSessionIdentity';
import { useComposerDraftPresence } from '@/hooks/useComposerDraftPresence';
import { useSessionPausedQueue } from '@/hooks/useSessionPausedQueue';
import { useGhostSessionBusy } from '@/cindy-brain/ghostSessionActivityStore';
import { useSessionAttentionKind } from '@/lib/sessionAttentionStore';
import { useSessionAttentionUrgency } from '../contexts/SessionAttentionUrgencyContext';
import { AttentionDot } from '@/components/sidebar/AttentionDot';
import { VendorIcon } from '@/components/sidebar/VendorIcon';

export interface SessionStatusIconProps {
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
  const isRunning = isAgentRunning || isGhostBusy;
  const vendor = session.agentKind === 'codex' ? 'codex' : 'cc';
  const isOrcaLead = isOrcaLeadSession(session);
  const isArchived = session.status === 'archived';
  // 角标 tone:error(含定时任务失败的 urgency context)红 > awaiting 蓝 > 完成未读绿。
  // 两个 hook 都是按 sessionId 的 primitive 精准订阅(性能不变量,见 SessionItem 头注),
  // 本组件也被逐行挂载,禁止退回整表订阅。
  const attentionKind = useSessionAttentionKind(session.id);
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

  return (
    <span className="relative shrink-0 inline-flex items-center justify-center size-3" aria-hidden>
      {isArchived ? (
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
      ) : (
        <VendorIcon
          vendor={vendor}
          size={size ?? (vendor === 'cc' ? 13 : 12)}
          running={isRunning}
          colorClassName={isActive ? 'text-[var(--sidebar-item-active-foreground)]' : undefined}
        />
      )}
      {showAttentionDot && hasAttentionNotification && (
        <AttentionDot size={6} tone={attentionTone} className="absolute -top-0.5 -right-0.5" />
      )}
      {showDraftIndicator && (
        <span
          className="absolute -bottom-0.5 -right-0.5 text-[var(--text-secondary)]"
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
