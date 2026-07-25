/**
 * ConnectProviderBanner — 零可用模型时已有会话顶部的「连接供应商」引导条。
 *
 * 与首屏 ConnectProviderCard 共享同一判定与 dismiss key(useProviderOnboarding):
 * 任一处 dismiss,两处一起消失。骨架对齐 UpgradeBanner(自判 visible、不可见渲染
 * null、挂载处零开销),但这是引导不是告警——用中性 token,不用 amber。
 */

import { Unplug, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { CSSProperties } from 'react';

import { cn } from '@/lib/utils';
import { useProviderOnboarding } from '@/hooks/useProviderOnboarding';
import { useSignInToCindy } from '@/hooks/useSignInToCindy';

export function ConnectProviderBanner({
  className,
  style,
}: {
  className?: string;
  style?: CSSProperties;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const signInToCindy = useSignInToCindy();
  const onboarding = useProviderOnboarding();

  if (!onboarding.visible) return null;

  const cloudMode = onboarding.authMode === 'cloud';

  return (
    <div
      data-testid="connect-provider-banner"
      className={cn(
        'mx-auto flex select-none items-center gap-2 rounded-md px-3 py-2',
        'border border-[var(--border-default)] bg-[var(--surface-elevated)]',
        className,
      )}
      style={style}
    >
      <Unplug size={14} className="shrink-0 text-[var(--text-secondary)]" />
      <span className="flex-1 text-xs text-[var(--text-secondary)]">
        {t('onboarding.connectProvider.banner.text')}
      </span>
      <button
        type="button"
        onClick={() => (cloudMode ? navigate('/settings?tab=providers') : void signInToCindy())}
        className="shrink-0 text-xs font-medium text-[var(--text-primary)] transition-opacity hover:opacity-70"
      >
        {cloudMode
          ? t('onboarding.connectProvider.banner.connectCta')
          : t('onboarding.connectProvider.banner.loginCta')}
      </button>
      <button
        type="button"
        onClick={onboarding.dismiss}
        aria-label={t('onboarding.connectProvider.banner.dismissAria')}
        className="shrink-0 text-[var(--text-tertiary)] transition-opacity hover:opacity-70"
      >
        <X size={12} />
      </button>
    </div>
  );
}
