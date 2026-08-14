/**
 * TakeoverMask
 * ---------------------------------------------------------------------------
 * 替代 ChatInput 渲染 — 当该 session 被某个 IM (现仅 feishu) 接管时, CCAgentSessionView
 * 不再挂 ChatInput, 改挂这个 mask 表达 "输入已禁用 + 当前正被远程接管 + 收回"。
 *
 * 视觉规格:
 *   - 容器: rounded-12, bg surface, border 1px Board, padding-x 16, gap 12, h-[90px]
 *   - 左: 32x32 圆形 chip (bg Light Gray) + radio-tower icon 16 (Stone)
 *   - 文字主: 14 / 500 / Near Black "此会话已被{channel} bot 接管 · 输入已禁用"
 *   - 文字副: 12 / 400 / Stone "来自 {user} 的{channel}私聊 · {hh:mm} 开始"
 *   - 右: Gray Pill (Light Gray bg, 14px text, 收回 + undo-2 icon)
 *
 * 收回按钮: invoke binding:revoke(sessionId), main 端会发飞书通知给对方 user.
 */

import { useState } from 'react';
import { RadioTower, Undo2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';

interface TakeoverMaskProps {
  sessionId: string;
  /** 接管发起方的 IM 渠道 (currently 'feishu') — 用于文案 */
  channel: string;
  /** 接管者在该 channel 下的标识 (feishu open_id, 短显尾段); 可空 */
  userId: string | null;
  /** Channel 上下文取的姓名 (e.g. 飞书姓名); 优先于 userId 显示 */
  displayName?: string | null;
}

function maskUserId(userId: string | null, fallback: string): string {
  if (!userId) return fallback;
  if (userId.length <= 8) return userId;
  return `…${userId.slice(-6)}`;
}

export function TakeoverMask({ sessionId, channel, userId, displayName }: TakeoverMaskProps) {
  const { t } = useTranslation();
  const [revoking, setRevoking] = useState(false);
  const channelLabels: Record<string, string> = {
    feishu: t('newChat.takeoverMask.channels.feishu'),
  };
  const channelLabel = channelLabels[channel] ?? channel;
  // 真实姓名优先 — main 端通过 channel 通讯录 API 取到的; 没取到走 open_id 末尾兜底。
  const userLabel = displayName?.trim() || maskUserId(userId, t('newChat.takeoverMask.remoteUser'));

  const handleRevoke = async () => {
    if (revoking) return;
    setRevoking(true);
    try {
      await window.electronAPI.binding.revoke(sessionId);
      // 不需要本地更新 state — main 端 onChange 会广播, useSessionBinding 重拉
      // attached=false, CCAgentSessionView 自然换回 ChatInput, 这个组件 unmount.
    } catch {
      setRevoking(false);
    }
  };

  return (
    <div
      className={cn(
        'flex w-full items-center justify-between gap-3',
        'h-[90px] rounded-[12px] px-4',
        'bg-[hsl(var(--content-area))]',
        'border border-[hsl(var(--sidebar-border))]',
      )}
    >
      <div className="flex items-center gap-[10px]">
        <div
          className={cn(
            'flex h-8 w-8 shrink-0 items-center justify-center rounded-full',
            'bg-[hsl(var(--sidebar-item-hover))]',
          )}
        >
          <RadioTower size={16} className="text-[var(--workingdir-icon)]" />
        </div>
        <div className="flex flex-col gap-[2px]">
          <div className="text-14 font-medium leading-tight text-[var(--msg-assistant-text)]">
            {t('newChat.takeoverMask.heading', { user: userLabel, channel: channelLabel })}
          </div>
          <div className="text-12 font-normal leading-tight text-[var(--workingdir-text)]">
            {t('newChat.takeoverMask.subtitle')}
          </div>
        </div>
      </div>
      <button
        type="button"
        onClick={handleRevoke}
        disabled={revoking}
        className={cn(
          'flex h-8 shrink-0 items-center gap-1.5 rounded-full px-4',
          'bg-[hsl(var(--sidebar-item-hover))]',
          'text-13 font-medium text-[var(--msg-assistant-text)]',
          'transition-colors hover:opacity-85',
          revoking && 'cursor-not-allowed opacity-60',
        )}
        aria-label={t('newChat.takeoverMask.revokeAria')}
      >
        <Undo2 size={14} />
        {/* relative top-[2px]: 中文字面视觉中心略偏上, 下移 2px 跟 icon 视觉对齐 */}
        <span className="relative top-[2px]">{revoking ? t('newChat.takeoverMask.revoking') : t('newChat.takeoverMask.revoke')}</span>
      </button>
    </div>
  );
}
