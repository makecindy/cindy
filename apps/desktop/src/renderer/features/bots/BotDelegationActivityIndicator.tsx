import { useCallback, useEffect, useMemo, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
  isDataOwnerPushCurrent,
} from '@/contexts/dataOwnerGeneration';
import { openBotDelegationsTab } from '@/features/right-sidebar/lib/openBotDelegationsTab';
import type {
  BotDelegationStatus,
  BotDelegationView,
} from '../../../shared/botDelegation';

/** 出向委派尚未落终态的状态集合，与右栏 Bot 协同 tab 的判据保持一致。 */
const ACTIVE_STATUSES = new Set<BotDelegationStatus>(['queued', 'waiting', 'running']);

/**
 * 与 right-sidebar/plugins/bot-delegations/BotDelegationsBody.tsx 的 formatDuration
 * 同一档位（s / m / h m）。这里刻意保留一份本地实现，让状态条自包含、不反向依赖右栏
 * 插件内部；改档位时两处要一起改。
 */
function formatDuration(start: number, end: number): string {
  const seconds = Math.max(0, Math.floor((end - start) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

interface Props {
  sessionId: string;
  /** 与消息流同宽，让状态条对齐正文而不是撑满整个聊天区。 */
  /**
   * 与消息流同宽。主干 2026-08 起把它从数字改成了 CSS 变量字符串
   * (`var(--cindy-message-width)`,由 ResizeObserver 直接更新,避免 React 每帧
   * 重渲染),所以这里两种都收 —— 值原样进 `style`,CSS 自己会算。
   */
  maxWidth?: number | string;
}

/**
 * 发起方（父任务）视图里的「Bot 委派进行中」状态条。
 *
 * 存在的理由：`delegate_to_bot` 之后子任务异步跑，父任务这边 agent 会停住等回传，
 * 界面上此前没有任何进行中的迹象。状态条只在本会话存在活跃出向委派时出现，全部落
 * 终态后自动消失；点击落到右栏已有的 Bot 协同 tab（单个委派时直接定位到详情）。
 *
 * 纯 renderer：数据来自既有 `maker.listBotDelegations` + `maker.onBotDelegationChanged`，
 * 不新增 IPC。数据主人切换（登出 / 切账号）时靠 dataOwnerGeneration 守卫丢弃旧结果。
 */
export function BotDelegationActivityIndicator({ sessionId, maxWidth }: Props) {
  const { t } = useTranslation();
  const [activeRows, setActiveRows] = useState<BotDelegationView[]>([]);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    const owner = getDataOwnerGeneration();
    try {
      const result = await window.electronAPI.maker.listBotDelegations(sessionId);
      if (!isDataOwnerGenerationCurrent(owner)) return;
      // 读不到就不显示：宁可少一条环境提示，也不要把无法核实的「进行中」一直挂着。
      //
      // parentSessionId 这层过滤是必须的：`listBotDelegations` 是**按伙伴**查的
      // （botDelegationService 的 WHERE 只有 requestingBotId，没有 parentSessionId），
      // 所以同一个伙伴在别的会话（例如 IM 通道任务）里发起的委派也会一并返回。
      // 不过滤的话，本会话顶上会挂一条「正在委派 X 处理…」，而下面 onBotDelegationChanged
      // 的推送守卫又是**按会话**的（payload.parentSessionId !== sessionId 直接 return），
      // 那条委派跑完后本会话永远收不到刷新 —— 转圈和计时会一直走到组件卸载为止。
      // 两侧口径必须一致：读和推都只认本会话。
      setActiveRows(
        result.ok
          ? result.delegations.filter(
              (row) => row.parentSessionId === sessionId && ACTIVE_STATUSES.has(row.status),
            )
          : [],
      );
    } catch {
      if (isDataOwnerGenerationCurrent(owner)) setActiveRows([]);
    }
  }, [sessionId]);

  useEffect(() => {
    setActiveRows([]);
    void load();
    return window.electronAPI.maker.onBotDelegationChanged((payload, ownerStamp) => {
      if (!isDataOwnerPushCurrent(ownerStamp) || payload.parentSessionId !== sessionId) return;
      void load();
    });
  }, [load, sessionId]);

  const startedAt = useMemo(
    () =>
      activeRows.length === 0
        ? null
        : activeRows.reduce((earliest, row) => Math.min(earliest, row.createdAt), Number.MAX_SAFE_INTEGER),
    [activeRows],
  );

  // 只在有活跃委派时才起秒级 tick，避免空转。
  useEffect(() => {
    if (startedAt === null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [startedAt]);

  if (activeRows.length === 0 || startedAt === null) return null;

  const single = activeRows.length === 1 ? activeRows[0] : null;
  const label = single
    ? t('rightSidebar.botDelegations.activity.single', { name: single.targetBotName })
    : t('rightSidebar.botDelegations.activity.multiple', { count: activeRows.length });

  return (
    <div className="shrink-0 px-4 pt-3">
      <div className="mx-auto" style={{ maxWidth: maxWidth ?? 880 }}>
        <button
          type="button"
          onClick={() => {
            void openBotDelegationsTab(sessionId, {
              focusDelegationId: single?.id,
              userInitiated: true,
            }).catch(() => undefined);
          }}
          aria-label={t('rightSidebar.botDelegations.activity.openAria')}
          // 层级刻意低于消息流里的协作卡：那张卡是对话的一部分（有边框、有动作），
          // 这条只是「滚出视口了也还在跑」的常驻提醒 —— 无边框、更小的字、次级色，
          // 两者同屏时不会看起来像同一个东西出现了两次。
          className="flex h-7 w-full items-center gap-2 rounded-full bg-[var(--surface-chip)] px-3 text-11 leading-none text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-secondary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
        >
          {/* --status-info 已进主题注册表（alias 到 --info-700，Light / Dark 两套值都有），
              不再需要消费点自带 fallback。 */}
          <span className="inline-flex shrink-0 animate-spin text-[var(--status-info)] motion-reduce:animate-none">
            <LoaderCircle size={13} />
          </span>
          <span className="min-w-0 flex-1 truncate text-left">{label}</span>
          <span className="shrink-0 text-11 text-[var(--text-tertiary)]">
            {formatDuration(startedAt, now)}
          </span>
        </button>
      </div>
    </div>
  );
}
