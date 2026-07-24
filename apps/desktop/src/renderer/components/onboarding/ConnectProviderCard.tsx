/**
 * ConnectProviderCard — 零可用模型时新会话首屏的「连接供应商」引导卡。
 *
 * 出现条件由 useProviderOnboarding 统一判定(零已连接来源 && 未 dismiss);
 * 挂载方(NewMakerDraftRoute)只决定位置与 device-link gate。所有行为都是导航,
 * 不在卡内做 OAuth:
 *   - 推荐行:cloud → 设置定位 Cindy AI(?connect=xd);signed-out/local → /login。
 *   - OAuth 行(Anthropic/OpenAI/xAI)→ 设置向导直达授权步(?connect=<id>)。
 *   - 「其他供应商」折叠区(API-key 预设)→ 向导直达预设表单步(?connect=<presetId>)。
 *   - 「我有 API key」→ 向导目录第一步(?wizard=1)。
 * 视觉:Card 抬起层 + 12px 容器 + chevron 动作行(参照 right-sidebar/EmptyState),
 * 全语义 token,light/dark 同步交付。
 */

import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, KeyRound } from 'lucide-react';

import { cn } from '@/lib/utils';
import { hasProviderLogo, ProviderLogoMark } from '@/components/icons/ProviderLogoMark';
import { providerMonogram } from '@/lib/providerModels';
import { providerSubtitleForDisplay } from '@/lib/providerSubtitle';
import { useProviderOnboarding } from '@/hooks/useProviderOnboarding';
import type { ProviderLogoRouting } from '@/components/icons/ProviderLogoMark';

function rowIcon(id: string, name: string, routing?: ProviderLogoRouting): ReactNode {
  if (hasProviderLogo(id, routing)) {
    return <ProviderLogoMark providerId={id} routing={routing} size={16} />;
  }
  return <span className="text-[13px] font-semibold leading-none">{providerMonogram(name)}</span>;
}

export function ConnectProviderCard({ className }: { className?: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const onboarding = useProviderOnboarding({ loadPresets: true });
  const [othersOpen, setOthersOpen] = useState(false);

  if (!onboarding.visible) return null;

  const { authMode, xdProvider, oauthProviders, presets } = onboarding;
  const cloudMode = authMode === 'cloud';
  const goConnect = (id: string) =>
    navigate(`/settings?tab=providers&connect=${encodeURIComponent(id)}`);

  return (
    <section
      data-testid="connect-provider-card"
      className={cn(
        'w-full rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-6',
        className,
      )}
    >
      <div className="flex flex-col gap-1">
        <h2 className="text-[18px] font-medium leading-snug text-[var(--text-primary)]">
          {t('onboarding.connectProvider.title')}
        </h2>
        <p className="text-[13px] leading-relaxed text-[var(--text-secondary)]">
          {t('onboarding.connectProvider.desc')}
        </p>
      </div>

      <div className="mt-4 flex flex-col">
        {/* 推荐行:Cindy AI(cloud)/ 登录 Cindy(signed-out・local) */}
        <ProviderRow
          icon={rowIcon('xd', xdProvider?.name ?? 'Cindy AI')}
          label={
            cloudMode
              ? (xdProvider?.name ?? t('onboarding.connectProvider.cindy.title'))
              : t('onboarding.connectProvider.cindy.loginTitle')
          }
          sub={
            cloudMode
              ? t('onboarding.connectProvider.cindy.desc')
              : t('onboarding.connectProvider.cindy.loginDesc')
          }
          badge={t('onboarding.connectProvider.recommendedLabel')}
          onClick={() => (cloudMode ? goConnect('xd') : navigate('/login'))}
        />
        {oauthProviders.map((p) => (
          <ProviderRow
            key={p.id}
            icon={rowIcon(p.id, p.name, p.routing)}
            label={p.name}
            sub={providerSubtitleForDisplay(p, t(`settings.providers.${p.id}.modelLabel`), {
              fallback: t(`settings.providers.${p.id}.subtitle`),
            })}
            onClick={() => goConnect(p.id)}
          />
        ))}

        {presets.length > 0 && (
          <>
            <button
              type="button"
              onClick={() => setOthersOpen((v) => !v)}
              className="group flex w-full items-center gap-3.5 border-b border-[var(--border-default)] px-1 py-3 text-left transition-colors hover:bg-[var(--surface-hover)]"
            >
              <span className="flex flex-1 text-[13px] font-medium text-[var(--text-secondary)]">
                {t('onboarding.connectProvider.othersToggle', { count: presets.length })}
              </span>
              <ChevronDown
                size={14}
                className={cn(
                  'text-[var(--text-tertiary)] transition-transform',
                  othersOpen && 'rotate-180',
                )}
              />
            </button>
            {othersOpen &&
              presets.map((preset) => (
                <ProviderRow
                  key={preset.id}
                  icon={rowIcon(preset.id, preset.name)}
                  label={preset.name}
                  sub={t('onboarding.connectProvider.presetSub')}
                  onClick={() => goConnect(preset.id)}
                />
              ))}
          </>
        )}
      </div>

      <div className="mt-4 flex items-center justify-between">
        <button
          type="button"
          onClick={onboarding.dismiss}
          className="rounded-full px-3 py-1.5 text-[13px] text-[var(--text-tertiary)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-secondary)]"
        >
          {t('onboarding.connectProvider.dismiss')}
        </button>
        <button
          type="button"
          onClick={() => navigate('/settings?tab=providers&wizard=1')}
          className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
        >
          <KeyRound size={13} />
          {t('onboarding.connectProvider.haveApiKey')}
        </button>
      </div>
    </section>
  );
}

function ProviderRow({
  icon,
  label,
  sub,
  badge,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  sub: string;
  badge?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex w-full items-center gap-3.5 border-b border-[var(--border-default)] px-1 py-3 text-left transition-colors hover:bg-[var(--surface-hover)]"
    >
      <span className="grid h-7 w-7 shrink-0 place-items-center text-[var(--text-secondary)]">
        {icon}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-2">
          <span className="truncate text-[14px] font-medium text-[var(--text-primary)]">
            {label}
          </span>
          {badge && (
            <span className="shrink-0 rounded-full border border-[var(--border-default)] px-2 py-px text-[10px] font-medium uppercase tracking-[0.06em] text-[var(--text-tertiary)]">
              {badge}
            </span>
          )}
        </span>
        <span className="truncate text-[11px] text-[var(--text-tertiary)]">{sub}</span>
      </span>
      <ChevronRight
        size={14}
        className="shrink-0 text-[var(--text-tertiary)] transition-transform group-hover:translate-x-0.5"
      />
    </button>
  );
}
