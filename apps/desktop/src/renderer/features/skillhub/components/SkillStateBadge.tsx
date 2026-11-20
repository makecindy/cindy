import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';

/**
 * SkillStateBadge — 技能启用状态的常驻标识。
 *
 * 技能列表卡片原本只显示来源（官方 / SkillHub / 本地），停用的技能与启用中的技能外形
 * 完全一致，用户必须逐个进入详情才能知道这个技能当前会不会被新任务加载。这里补一个
 * 列表上就能看到的启停状态：停用比启用更值得注意，因此停用带填充底，启用只留弱化文字。
 * 文案始终存在，颜色不单独承载状态。
 */
export function SkillStateBadge({ enabled, className }: { enabled: boolean; className?: string }) {
  const { t } = useTranslation();
  return (
    <span
      className={cn(
        'inline-flex h-5 shrink-0 items-center rounded-full px-2 text-11 font-medium leading-none',
        enabled
          ? 'text-[var(--text-tertiary)]'
          : 'bg-[var(--surface-chip)] text-[var(--text-secondary)]',
        className,
      )}
      title={t(enabled ? 'skillhub.home.stateEnabledHint' : 'skillhub.home.stateDisabledHint')}
    >
      {t(enabled ? 'skillhub.home.stateEnabled' : 'skillhub.home.stateDisabled')}
    </span>
  );
}
