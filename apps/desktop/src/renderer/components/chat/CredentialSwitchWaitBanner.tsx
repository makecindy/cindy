/**
 * CredentialSwitchWaitBanner — 凭证切换等待横幅
 * ---------------------------------------------------------------------------
 * 发送的消息需要按本会话选择的模型来源重启共享 Codex 进程,但其它本地 Codex
 * 任务正在运行。main 侧把消息保留在队首、挡路任务结束后自动重发(input
 * coordinator 的 credentialSwitchWait 状态),这里只负责把"正在等谁、结束后会
 * 自动发送"讲清楚,并提供取消入口(删除队首消息 = 取消等待)。
 *
 * 视觉:amber warning 语义(waiting/in-progress 通知),复用 upgrade-banner
 * token(语义豁免色,跨主题统一;规则 16)。与 ErrorBanner(红)区分——等待
 * 不是错误。
 */

import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { projectDraftSessionTitle } from '@cindy/maker-shared/session-title';
import * as sessionService from '@/lib/sessionService';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';

interface CredentialSwitchWaitBannerProps {
  /** 挡路的本地 Codex 会话 ids(main 透传;可能为空 = 未知)。 */
  blockedBySessionIds: string[];
  /** 取消等待(上层删除队首消息)。无队首时不显示取消按钮。 */
  onCancel?: () => void;
  style?: React.CSSProperties;
  className?: string;
}

export function CredentialSwitchWaitBanner({
  blockedBySessionIds,
  onCancel,
  style,
  className,
}: CredentialSwitchWaitBannerProps) {
  const { t, i18n } = useTranslation();
  const [blockerTitles, setBlockerTitles] = useState<string[]>([]);
  // projection 每次 emit 都会产出新数组身份(等待期间 2s 重试周期也在 emit),
  // 以内容 key 做依赖,避免标题反复重拉。sessionId 不含逗号,join 无碰撞。
  const blockersKey = blockedBySessionIds.join(',');

  // best-effort 解析挡路会话标题(失败/无标题静默降级为通用文案)。
  useEffect(() => {
    let cancelled = false;
    const ids = blockersKey ? blockersKey.split(',') : [];
    if (ids.length === 0) {
      setBlockerTitles([]);
      return;
    }
    void Promise.all(
      ids.map((id) =>
        sessionService
          .get(id)
          .then((session) => session.title?.trim() || null)
          .catch(() => null),
      ),
    ).then((titles) => {
      if (cancelled) return;
      setBlockerTitles(titles.filter((title): title is string => Boolean(title)));
    });
    return () => {
      cancelled = true;
    };
  }, [blockersKey]);

  // 未起名会话过投影再拼进文案:横幅里原样会露出内部哨兵 "New Maker"。
  // 刻意在**渲染这一刻**投影、state 里存原始标题:切语言后本次渲染就跟着变,
  // 不用为了刷新文案重新拉一遍标题(本 PR 的第 8 条不变量)。
  const displayTitles = blockerTitles.map(
    (title) => projectDraftSessionTitle(title, t('ccAgent.common.unnamedSession')),
  );
  // 标题连接符跟随当前语言(zh/ja 顿号、en/ko 逗号等),不硬编码中文顿号。
  // Intl.ListFormat 在 Electron 的 V8 下全量可用;构造失败(异常 locale)回退简单逗号。
  let joinedTitles = '';
  if (displayTitles.length > 0) {
    try {
      joinedTitles = new Intl.ListFormat(i18n.language || 'en', {
        style: 'narrow',
        type: 'unit',
      }).format(displayTitles);
    } catch {
      joinedTitles = displayTitles.join(', ');
    }
  }
  const message = displayTitles.length > 0
    ? t('chat.credentialSwitchWait.waitingForNamed', { titles: joinedTitles })
    : t('chat.credentialSwitchWait.waiting');

  return (
    <div
      className={cn(
        'mx-auto flex select-none items-start gap-2 rounded-md px-3 py-2',
        'bg-[var(--upgrade-banner-bg)] border border-[var(--upgrade-banner-border)]',
        className,
      )}
      style={style}
    >
      <Spinner size={14} className="mt-[2px] text-[var(--upgrade-banner-fg)]" />
      <span className="flex-1 min-w-0 text-xs text-[var(--upgrade-banner-fg)] break-all">
        {message}
      </span>
      {onCancel && (
        <button
          type="button"
          onClick={onCancel}
          className={cn(
            'shrink-0 flex items-center gap-1 text-xs font-medium',
            'text-[var(--upgrade-banner-fg)]',
            'hover:opacity-70 transition-opacity',
          )}
          title={t('chat.credentialSwitchWait.cancelTitle')}
        >
          <X size={12} />
          {t('chat.credentialSwitchWait.cancel')}
        </button>
      )}
    </div>
  );
}
