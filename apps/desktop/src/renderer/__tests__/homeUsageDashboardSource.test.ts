import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const source = readFileSync(
  resolve(__dirname, '../components/new-chat/HomeUsageDashboard.tsx'),
  'utf8',
);
const dailyBarsSource = readFileSync(
  resolve(__dirname, '../components/new-chat/UsageDailyBars.tsx'),
  'utf8',
);
const heatmapSource = readFileSync(
  resolve(__dirname, '../components/new-chat/UsageHeatmap.tsx'),
  'utf8',
);

describe('HomeUsageDashboard source contract', () => {
  it('uses the Claude account daily spend for the visible today amount when available', () => {
    expect(source).toMatch(
      /const accountTodayMoney =\s+typeof claudeQuota\?\.todaySpend === 'number'\s+\? gatewayMoney\(claudeQuota\.todaySpend\)\s+: null;/,
    );
    expect(source).toContain('const hasAccountTodaySpend = accountTodayMoney !== null;');
    expect(source).toContain('const layoutHistory = history ?? emptyLayoutHistory;');
    expect(source).toContain(
      'const displayTodaySpend = accountTodayMoney ?? layoutHistory.totals.today;',
    );
    expect(source).toContain('const ACCOUNT_LOCAL_TODAY_MATCH_EPSILON = 0.01;');
    expect(source).toMatch(
      /function isSameDisplayedTodaySpend\(\s+accountTodaySpend: RegionalMoney \| null,\s+localTodaySpend: RegionalMoney,\s+\): boolean/,
    );
    expect(source).toMatch(
      /layoutHistory\.anomaly\.isAnomalous &&\s+isSameDisplayedTodaySpend\(accountTodayMoney, layoutHistory\.totals\.today\);/,
    );
    expect(source).toContain(
      '`${formatMoney(displayTodaySpend)} / ${formatCompactMoney(softDailyLimitMoney)}`',
    );
    expect(source).toMatch(
      /hasSpendValue \?\s+formatMoney\(displayTodaySpend\)\s+:\s+UNKNOWN_VALUE/,
    );
    expect(source).toContain('warning={showLocalSpendAnomaly}');
  });

  it('keeps a fixed empty layout while usage history is still loading or empty', () => {
    expect(source).toContain('function createEmptyUsageHistoryPayload(): UsageHistoryPayload');
    expect(source).toMatch(
      /const \[emptyLayoutHistory\] = useState<UsageHistoryPayload>\(\(\) =>\s+createEmptyUsageHistoryPayload\(\),\s+\);/,
    );
    expect(source).toContain('const hasHistoryData = history !== null;');
    expect(source).toContain('const tokenValue =');
    expect(source).toContain('`${UNKNOWN_VALUE} / ${UNKNOWN_VALUE}`');
    expect(source).toMatch(
      /const streakValue = hasHistoryData\s+\? t\('usageDashboard\.streakValue', \{\s+current: layoutHistory\.streak\.current,\s+longest: layoutHistory\.streak\.longest,\s+\}\)\s+: `\$\{UNKNOWN_VALUE\} \/ \$\{UNKNOWN_VALUE\}`;/,
    );
    expect(source).toMatch(
      /hasHistoryData\s+\? t\('usageDashboard\.collapsedStreak', \{ n: layoutHistory\.streak\.current \}\)\s+: UNKNOWN_VALUE/,
    );
    expect(source).not.toContain('return null;');
    expect(source).not.toContain('history.days.length === 0 && history.models.length === 0');
  });

  it('uses the default usage currency for empty chart cells', () => {
    expect(heatmapSource).toContain('DEFAULT_USAGE_CURRENCY');
    expect(dailyBarsSource).toContain('DEFAULT_USAGE_CURRENCY');
    expect(heatmapSource).not.toContain("money.currency ?? 'USD'");
    expect(dailyBarsSource).not.toContain("money.currency ?? 'USD'");
  });

  it('shows cached usage immediately while marking background refresh', () => {
    expect(source).toContain(
      'const { history, refreshing: usageRefreshing } = useUsageHistory({ paused: collapsed, userId: user?.id });',
    );
    expect(source).toContain('const { user } = useAuth();');
    expect(source).toContain('const layoutHistory = history ?? emptyLayoutHistory;');
    expect(source).toContain("t('usageDashboard.updating')");
  });

  it('shows token model distribution in the token stat tooltip', () => {
    expect(source).toContain('const TOKEN_DISTRIBUTION_TOP_MODELS = 5;');
    expect(source).toContain('const tokenDistributionRows =');
    expect(source).toContain("t('usageDashboard.tokenDistributionTitle'");
    expect(source).toContain("t('usageDashboard.tokenDistributionRow'");
    expect(source).toContain('warningTip={tokenDistributionTip}');
  });

  it('loads once while collapsed but skips usage push subscriptions', () => {
    expect(source).toContain('useUsageHistory({ paused: collapsed, userId: user?.id })');
    const hookSource = readFileSync(resolve(__dirname, '../hooks/useUsageHistory.ts'), 'utf8');
    const loadIndex = hookSource.indexOf('void load(scopeKey);');
    const pausedIndex = hookSource.indexOf('if (paused) {');
    const pushIndex = hookSource.indexOf('window.electronAPI.maker.usage.onTodaySpendChanged');
    const tokenPushIndex = hookSource.indexOf(
      'window.electronAPI.maker.usage.onTodayTokensChanged',
    );
    expect(loadIndex).toBeGreaterThan(0);
    expect(pausedIndex).toBeGreaterThan(0);
    expect(loadIndex).toBeLessThan(pausedIndex);
    expect(pushIndex).toBeGreaterThan(pausedIndex);
    expect(tokenPushIndex).toBeGreaterThan(pausedIndex);
  });

  it('scopes renderer usage-history snapshots by account', () => {
    const hookSource = readFileSync(resolve(__dirname, '../hooks/useUsageHistory.ts'), 'utf8');
    expect(hookSource).toContain('function storageKeyForScope(scopeKey: string): string');
    expect(hookSource).toContain('localStorage.getItem(storageKeyForScope(scopeKey))');
    expect(hookSource).toContain(
      'localStorage.setItem(storageKeyForScope(scopeKey), JSON.stringify(p))',
    );
    expect(hookSource).toContain('const scopes = new Map<string, UsageHistoryScopeState>();');
    expect(hookSource).toContain('const scopeKey = normalizeScopeKey(opts?.userId);');
  });

  it('does not render the previous account history after the scope changes', () => {
    const hookSource = readFileSync(resolve(__dirname, '../hooks/useUsageHistory.ts'), 'utf8');
    expect(hookSource).toContain(
      'const [historyState, setHistoryState] = useState<{ scopeKey: string; value: UsageHistoryPayload | null }>',
    );
    expect(hookSource).toContain('setHistoryState({ scopeKey, value });');
    expect(hookSource).toContain(
      'history: historyState.scopeKey === scopeKey ? historyState.value : scope.cache,',
    );
  });

  it('adds subscription estimates to mixed actual daily bars', () => {
    expect(dailyBarsSource).toContain('const subscriptionEstimateSum = segments.reduce(');
    expect(dailyBarsSource).toContain('actualAmount + subscriptionEstimateSum,');
    expect(dailyBarsSource).toContain(
      'segments.some((segment) => segment.subscriptionEstimateAmount > 0)',
    );
    expect(dailyBarsSource).toContain("money(subscriptionEstimateSum, true, 'value-estimate')");
  });

  it('force-refreshes delayed pricing retries instead of reusing pending memory cache', () => {
    const hookSource = readFileSync(resolve(__dirname, '../hooks/useUsageHistory.ts'), 'utf8');
    expect(hookSource).toContain('scope.pricingRetryTimer = setTimeout(() => {');
    expect(hookSource).toContain('void load(scopeKey, { forceRefresh: true });');
    expect(hookSource).not.toContain('setTimeout(() => void load(), PRICING_RETRY_DELAY_MS);');
  });

  it('cancels delayed retries when a usage scope is no longer active', () => {
    const hookSource = readFileSync(resolve(__dirname, '../hooks/useUsageHistory.ts'), 'utf8');
    expect(hookSource).toContain('pricingRetryTimer: ReturnType<typeof setTimeout> | null;');
    expect(hookSource).toContain(
      'function deactivateScopeIfUnused(scope: UsageHistoryScopeState): void',
    );
    expect(hookSource).toContain('cancelScopeTimers(scope);');
    expect(hookSource).toContain('scope.loadSeq += 1;');
    expect(hookSource).toContain('deactivateScopeIfUnused(activeScope);');
    expect(hookSource).toContain(
      'if (scope.listeners.size === 0 && scope.statusListeners.size === 0) return;',
    );
  });

  it('resets the pricing retry gate after successful loads and usage-push refreshes', () => {
    const hookSource = readFileSync(resolve(__dirname, '../hooks/useUsageHistory.ts'), 'utf8');
    expect(hookSource).toContain('opts?: { forceRefresh?: boolean; resetPricingRetry?: boolean }');
    expect(hookSource).toContain('if (opts?.resetPricingRetry) scope.pricingRetryDone = false;');
    expect(hookSource).toContain('scope.pricingRetryDone = false;');
    expect(hookSource).toContain(
      'void load(scopeKey, { forceRefresh: true, resetPricingRetry: true });',
    );
  });

  it('does not retry forever for permanent Codex null estimates', () => {
    const hookSource = readFileSync(resolve(__dirname, '../hooks/useUsageHistory.ts'), 'utf8');
    expect(hookSource).toContain('if (next.estimatesPending) {');
    expect(hookSource).not.toContain(
      "next.models.some((m) => m.agentKind === 'codex' && m.estimatedCostUsd === null)",
    );
  });
});
