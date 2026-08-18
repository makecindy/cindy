/**
 * SettingsContentHeader — 设置页注入 ContentHeader 的中部内容
 * ---------------------------------------------------------------------------
 * 设置页的返回 + 标题走和聊天一样的 46px ContentHeader，不再在侧栏上方
 * 再叠一层页头留白。交互控件挖 no-drag 洞，其余区域继续拖窗口。
 */

import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft } from 'lucide-react';

import { WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';
import { useRegisterContentHeader } from '@/features/feature-context';

export function SettingsContentHeaderRegistration() {
  useRegisterContentHeader(useMemo(() => <SettingsContentHeader />, []));
  return null;
}

export function SettingsContentHeader() {
  const navigate = useNavigate();
  const { t } = useTranslation();

  return (
    <div className="flex h-full min-w-0 items-center gap-2.5">
      <button
        type="button"
        onClick={() => navigate('/')}
        aria-label={t('settings.back')}
        className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--settings-back-icon)] transition-colors hover:bg-titlebar-button-hover hover:text-[var(--settings-back-text)]"
        style={WINDOW_NO_DRAG_STYLE}
      >
        <ArrowLeft size={15} />
      </button>
      <h1 className="truncate text-sm font-medium text-[var(--settings-back-text)]">
        {t('settings.title')}
      </h1>
    </div>
  );
}
