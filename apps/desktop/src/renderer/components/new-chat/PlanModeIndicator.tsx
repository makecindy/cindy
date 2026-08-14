/**
 * PlanModeIndicator —— 计划模式激活态 chip(composer 上方,与 GoalIndicator 同形)。
 *
 * 计划模式是与 permissionMode 正交的一级会话开关(入口在 composer「+」菜单,与
 * 「新建目标」同级):开启时 agent 先产出计划、经用户审批后再执行。此 chip 只负责
 * 「开启中」的可见性 + 一键退出;开关持久化由父组件(ChatInput → store / draft)处理。
 *
 * 颜色全走主题 token(规则 16):surface-chip / border-default / text-secondary,
 * 与 GoalIndicator 常规态一致,无语义色。
 */

import { ClipboardList, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface PlanModeIndicatorProps {
  /** 点击 X 退出计划模式(父组件负责真正的切换 + 持久化)。 */
  onExit: () => void;
  /** 只读态(断线远程会话等):隐藏退出按钮。 */
  disabled?: boolean;
}

export function PlanModeIndicator({ onExit, disabled }: PlanModeIndicatorProps): React.ReactElement {
  const { t } = useTranslation();
  return (
    <div
      className="mx-auto flex max-w-full select-none items-center gap-2 rounded-lg px-2.5 py-1.5 text-12"
      style={{
        backgroundColor: 'var(--surface-chip)',
        border: '1px solid var(--border-default)',
      }}
    >
      <ClipboardList
        size={13}
        strokeWidth={2}
        aria-hidden
        className="shrink-0"
        style={{ color: 'var(--text-secondary)' }}
      />
      <span className="shrink-0 font-medium" style={{ color: 'var(--text-secondary)' }}>
        {t('planMode.indicator.title')}
      </span>
      <span className="min-w-0 flex-1 truncate" style={{ color: 'var(--text-tertiary)' }}>
        {t('planMode.indicator.hint')}
      </span>
      {!disabled && (
        <button
          type="button"
          aria-label={t('planMode.exit')}
          title={t('planMode.exit')}
          className="flex h-4 w-4 shrink-0 items-center justify-center rounded transition-colors hover:bg-[var(--surface-elevated)]"
          style={{ color: 'var(--text-tertiary)' }}
          onClick={onExit}
        >
          <X size={12} strokeWidth={2} />
        </button>
      )}
    </div>
  );
}
