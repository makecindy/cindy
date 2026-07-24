/**
 * ConnectProviderCard — 零可用模型时新会话首屏的「连接供应商」引导卡。
 *
 * 出现条件由 useProviderOnboarding 统一判定(零已连接来源 && 未 dismiss);
 * 挂载方(NewMakerDraftRoute)只决定位置与 device-link gate。所有行为都是导航,
 * 不在卡内做 OAuth:
 *   - 推荐行:cloud → 设置定位 Cindy AI(?connect=xd);signed-out/local → /login。
 *   - 主列表/「其他供应商」折叠区按构建区域装配(cn=国内预设主列,global=OAuth
 *     三家主列,见 useProviderOnboarding.primaryRows 注释):内置渠道 → 向导授权步,
 *     预设 → 向导表单步(均 ?connect=<id>)。
 *   - 「我有 API key」→ 向导目录第一步(?wizard=1)。
 * 视觉:Card 抬起层 + 12px 容器 + chevron 动作行(参照 right-sidebar/EmptyState),
 * 全语义 token,light/dark 同步交付。
 */

import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, KeyRound } from 'lucide-react';

import { presetDisplayName } from '@cindy/model-providers';

import { cn } from '@/lib/utils';
import { hasProviderLogo, ProviderLogoMark } from '@/components/icons/ProviderLogoMark';
import { providerMonogram } from '@/lib/providerModels';
import { useProviderOnboarding } from '@/hooks/useProviderOnboarding';
import { useSignInToCindy } from '@/hooks/useSignInToCindy';
import type { ProviderOnboardingRow } from '@/hooks/useProviderOnboarding';
import type { ProviderLogoRouting } from '@/components/icons/ProviderLogoMark';

function rowIcon(id: string, name: string, routing?: ProviderLogoRouting): ReactNode {
  if (hasProviderLogo(id, routing)) {
    return <ProviderLogoMark providerId={id} routing={routing} size={16} />;
  }
  return <span className="text-[13px] font-semibold leading-none">{providerMonogram(name)}</span>;
}

export function ConnectProviderCard({ className }: { className?: string }) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const signInToCindy = useSignInToCindy();
  const onboarding = useProviderOnboarding({ loadPresets: true });
  const [othersOpen, setOthersOpen] = useState(false);

  if (!onboarding.visible) return null;

  const { authMode, xdProvider, detectedRows, primaryRows, moreRows } = onboarding;
  const cloudMode = authMode === 'cloud';
  const goConnect = (id: string) =>
    navigate(`/settings?tab=providers&connect=${encodeURIComponent(id)}`);

  // 文案学 Hermes:副标题说「接下来会发生什么」(浏览器授权/填 key),
  // 不复述模型目录信息——模型归属看行标题就够了。
  const renderRow = (row: ProviderOnboardingRow) =>
    row.kind === 'builtin' ? (
      <ProviderRow
        key={row.provider.id}
        icon={rowIcon(row.provider.id, row.provider.name, row.provider.routing)}
        label={row.provider.name}
        sub={t('onboarding.connectProvider.oauthSub')}
        onClick={() => goConnect(row.provider.id)}
      />
    ) : (
      <ProviderRow
        key={row.preset.id}
        icon={rowIcon(row.preset.id, presetDisplayName(row.preset, i18n.language))}
        label={presetDisplayName(row.preset, i18n.language)}
        sub={t('onboarding.connectProvider.presetSub')}
        onClick={() => goConnect(row.preset.id)}
      />
    );

  return (
    <section
      data-testid="connect-provider-card"
      className={cn(
        'w-full rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-5',
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
        {/* 本机 CLI 检测行置顶(hook 已保证 installed && loggedIn):本机有登录态
            凭证 = 一键授权大概率直接成功,是最低摩擦路径,优先于推荐行。 */}
        {detectedRows.map(({ provider, detection }) => {
          const cliName = detection.cli === 'claude-cli' ? 'Claude Code CLI' : 'Codex CLI';
          return (
            <ProviderRow
              key={`detected-${provider.id}`}
              icon={rowIcon(provider.id, provider.name, provider.routing)}
              label={provider.name}
              sub={t('settings.providers.detect.hintLoggedIn', { cli: cliName })}
              badge={t('onboarding.connectProvider.detectedLabel')}
              onClick={() => goConnect(provider.id)}
            />
          );
        })}
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
          onClick={() => (cloudMode ? goConnect('xd') : void signInToCindy())}
        />
        {primaryRows.map(renderRow)}

        {moreRows.length > 0 && (
          <>
            <button
              type="button"
              onClick={() => setOthersOpen((v) => !v)}
              aria-expanded={othersOpen}
              aria-controls="connect-provider-more"
              className="group flex w-full items-center gap-3.5 border-b border-[var(--border-default)] px-1 py-3 text-left transition-colors hover:bg-[var(--surface-hover)]"
            >
              <span className="flex flex-1 text-[13px] font-medium text-[var(--text-secondary)]">
                {t('onboarding.connectProvider.othersToggle', { count: moreRows.length })}
              </span>
              <ChevronDown
                size={14}
                className={cn(
                  'text-[var(--text-tertiary)] transition-transform',
                  othersOpen && 'rotate-180',
                )}
              />
            </button>
            <div id="connect-provider-more" className="flex flex-col" hidden={!othersOpen}>
              {othersOpen && moreRows.map(renderRow)}
            </div>
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
