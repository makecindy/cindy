/**
 * 插件就绪态徽章(列表卡 / 详情页共用)。
 *
 * 只在非 ready 时渲染;颜色全走语义 token(双模式自动适配):
 * - needs_setup / unknown:警示(需要用户处置)
 * - needs_reauth:错误(授权失效,动作是重新连接)
 * - degraded:错误(运行异常)
 * ready / blocked 不渲染(ready 是常态不该有徽章;blocked 由账号面
 * 入口统一收口,不在插件卡片上重复表达)。
 */

import { useTranslation } from 'react-i18next';

import type { GhostReadiness } from '../../../shared/ghostLifecycle';
import { cn } from '../../lib/utils';

const TONE_CLASS: Record<'warning' | 'error', string> = {
  warning: 'bg-[var(--surface-chip)] text-[var(--warning-accent)]',
  error: 'bg-[var(--surface-chip)] text-[var(--error-fg)]',
};

const BADGE_PROPS: Partial<Record<GhostReadiness, { tone: 'warning' | 'error'; key: string }>> = {
  needs_setup: { tone: 'warning', key: 'settings.ghosts.readiness.needsSetup' },
  unknown: { tone: 'warning', key: 'settings.ghosts.readiness.unknown' },
  needs_reauth: { tone: 'error', key: 'settings.ghosts.readiness.needsReauth' },
  degraded: { tone: 'error', key: 'settings.ghosts.readiness.degraded' },
};

export function GhostReadinessBadge({ readiness }: { readiness: GhostReadiness }) {
  const { t } = useTranslation();
  const props = BADGE_PROPS[readiness];
  if (!props) return null;
  return (
    <span
      className={cn(
        'shrink-0 select-none rounded-full px-2 py-0.5 text-10 font-medium leading-4',
        TONE_CLASS[props.tone],
      )}
    >
      {t(props.key)}
    </span>
  );
}
