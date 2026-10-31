/**
 * ProviderAccountUsageModule —— API Key 计费供应商的余额/额度卡（设置 → 模型供应商详情）。
 *
 * 样式完全对齐订阅卡（Codex/Claude/xAI）：同一个 QuotaHoverCard、同一个壳。差异只在
 * 数据源——这里经 useProviderAccountUsage 读供应商自己的账户接口（DeepSeek 余额、
 * 智谱 Coding Plan 额度窗口），投影成 UsageCardAccount 后交同一张卡渲染。不支持的
 * 供应商返回 null，不占位。
 */

import { isKimiCodingProviderView } from '../../../shared/kimiCodingUsage';
import { useTranslation } from 'react-i18next';

import type { ProviderView } from '@cindy/model-providers';

import {
  getProviderAccountUsageDashboardUrlView,
  hasDeepSeekOfficialRouteView,
  isZhipuCodingPlanProviderView,
} from '../../lib/providerAccountUsageView';
import { useProviderAccountUsage } from '../../hooks/useProviderAccountUsage';
import { Button } from '../ui/button';
import { QuotaHoverCard } from '../status/QuotaHoverCard';
import { buildDeepSeekUsageCard, buildZhipuUsageCard, buildKimiUsageCard } from '../status/usageCardModel';

export function ProviderAccountUsageModule({ provider }: { provider?: ProviderView }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const deepSeek = hasDeepSeekOfficialRouteView(provider);
  const zhipu = isZhipuCodingPlanProviderView(provider);
  const kimi = isKimiCodingProviderView(provider);
  const usage = useProviderAccountUsage(deepSeek || zhipu || kimi ? provider : undefined);
  const dashboardUrl = usage.result?.dashboardUrl ?? getProviderAccountUsageDashboardUrlView(provider);
  if (!deepSeek && !zhipu && !kimi) return null;
  const snapshot = usage.result?.status === 'ready' ? usage.result.snapshot : null;
  const errorText =
    usage.result?.status === 'unavailable'
      ? t(`providerAccountUsage.${kimi ? 'kimi.' : ''}error.${usage.result.error}`)
      : null;
  const account = kimi
    ? buildKimiUsageCard(snapshot?.kind === 'kimi-coding-quota' ? snapshot : null, t)
    : deepSeek
    ? buildDeepSeekUsageCard(snapshot?.kind === 'deepseek-balance' ? snapshot : null, t, locale)
    : buildZhipuUsageCard(snapshot?.kind === 'zhipu-coding-plan-quota' ? snapshot : null, t);
  if (errorText && !snapshot) account.emptyText = errorText;
  // 余额来自哪个引擎的密钥：同一供应商各引擎可用不同账户，标注免得用户误读。
  if (!kimi && usage.result?.status === 'ready' && usage.result.agent) {
    account.identity ??=
      usage.result.agent === 'claude-code'
        ? 'Claude Code'
        : usage.result.agent === 'codex'
          ? 'Codex'
          : 'Pi';
  }

  if (kimi && usage.result?.status === 'ready' && usage.result.stale) {
    account.notices = [{ text: t('providerAccountUsage.kimi.stale'), tone: 'warn' }];
  }

  return (
    <div
      data-testid="provider-usage-module"
      className="border-t px-1 py-2"
      style={{ borderColor: 'var(--settings-theme-card-border)' }}
    >
      <QuotaHoverCard
        variant="embedded"
        account={account}
        dashboardLabel={kimi ? t('providerAccountUsage.kimi.usage') : deepSeek ? t('providerAccountUsage.openDashboard') : t('providerAccountUsage.zhipuCodingPlan.usage')}
        onOpenDashboard={dashboardUrl ? () => void window.electronAPI.openExternal(dashboardUrl) : undefined}
      >
        {kimi && <div className="px-4 pb-2"><Button variant="secondary" tone="quiet" size="sm" disabled={usage.busy} onClick={usage.refresh}>{t('providerAccountUsage.kimi.refresh')}</Button></div>}
      </QuotaHoverCard>
    </div>
  );
}
