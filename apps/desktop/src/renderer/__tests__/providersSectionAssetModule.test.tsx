// @vitest-environment jsdom

/**
 * ProvidersSection — Cindy AI 卡片的「账户资产模块」不变量：
 *   1. 个人云账号 + 拿到余额 → 标题行下方出现「可用余额 + 金额 + 查看用量」；右侧一颗
 *      Black Pill 按套餐状态切换：非套餐购买套餐、还能升就升级、升满后才余额充值。
 *      查看用量始终在。
 *   2. 企业账号 → 整块不渲染（不是灰置、不给占位）。
 *   3. 凭据同步失败 → 故障说明 + 重试，且**不显示「已连接」**（凭据没同步上，说已连接是假的）。
 *   4. 正常态版面上不出现「重试 / 重新获取凭据 / 轮换密钥」这类按钮 —— 它们退进「···」菜单。
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProviderView } from '@cindy/model-providers';

const {
  providersState,
  authState,
  creditUsageState,
  modelAccessState,
  apiKeyState,
  primaryActionState,
} = vi.hoisted(() => ({
  providersState: { providers: [] as unknown[], order: [] as string[] },
  authState: {
    mode: 'cloud' as 'cloud' | 'local' | 'signed-out',
    user: { membershipKind: 'personal' } as { membershipKind: 'personal' | 'org' } | null,
    dataOwnerId: 'account-1' as string | null,
  },
  creditUsageState: { available: null as string | null },
  modelAccessState: {
    state: 'ok' as 'ok' | 'failed' | 'unsupported' | 'idle' | 'syncing' | 'disabled',
    source: 'server' as string | null,
    accountTier: null as 'free' | 'paid' | 'not_applicable' | null,
  },
  apiKeyState: { key: 'sk-live-abcd1234ef2a', hasSavedKey: true },
  primaryActionState: {
    value: 'buy-plan' as 'buy-plan' | 'upgrade-plan' | 'topup' | null,
    lastEnabled: false,
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'zh-CN', resolvedLanguage: 'zh-CN' },
  }),
}));

vi.mock('@/hooks/useProviders', () => ({
  useProviders: () => ({
    providers: providersState.providers,
    providerOrder: providersState.order,
    ownerGeneration: 1,
    loading: false,
    refetch: vi.fn(),
  }),
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ ...authState, exitLocalMode: vi.fn(async () => undefined) }),
}));

vi.mock('@/hooks/useModelAccessCreditUsage', () => ({
  useModelAccessCreditUsage: (enabled: boolean) =>
    enabled && creditUsageState.available !== null
      ? { available: creditUsageState.available }
      : null,
}));

vi.mock('@/hooks/useXdAssetPrimaryAction', () => ({
  useXdAssetPrimaryAction: (enabled: boolean) => {
    primaryActionState.lastEnabled = enabled;
    return enabled ? primaryActionState.value : null;
  },
}));

vi.mock('@/hooks/useModelAccessStatus', () => ({
  useModelAccessStatus: () => ({ ...modelAccessState, endpoint: null }),
}));

vi.mock('@/hooks/useApiKey', () => ({
  useApiKey: () => ({ ...apiKeyState, clearKey: vi.fn(async () => true) }),
}));

vi.mock('@/hooks/useCodexAuth', () => ({
  isChatGptConnectionConnected: () => false,
  useCodexAuth: () => ({
    state: { kind: 'unauthenticated' },
    reconnectCredentialScope: undefined,
    recoveryCheck: 'idle',
    refresh: vi.fn(async () => undefined),
    triggerLogin: vi.fn(async () => 'authenticated'),
    cancelLogin: vi.fn(async () => undefined),
    logout: vi.fn(async () => undefined),
  }),
}));

vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: vi.fn(async () => true) }),
}));

vi.mock('@/lib/toast', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock('@/lib/customProviders', () => ({
  appendDiscoveredCustomProviderModels: vi.fn(),
  deleteCustomProvider: vi.fn(),
  providerViewToCustomProviderConfig: vi.fn(),
  readCustomProviderKey: vi.fn(async () => null),
  updateCustomProvider: vi.fn(),
}));

vi.mock('@/lib/providerModels', () => ({
  providerMonogram: () => 'X',
}));

vi.mock('@/lib/providerSubtitle', () => ({
  customProviderSubtitleForDisplay: () => '',
  providerSubtitleForDisplay: () => 'subtitle',
}));

vi.mock('@/state/modelVisibilityPrefs', () => ({
  isModelEnabled: () => true,
  setModelVisibilities: vi.fn(),
  setModelVisibility: vi.fn(),
  useModelVisibilityVersion: () => 0,
}));

vi.mock('@/components/settings/CustomProviderDialog', () => ({
  CustomProviderDialog: () => null,
}));

vi.mock('@/components/settings/AddProviderWizard', () => ({
  AddProviderWizard: () => React.createElement('div', { 'data-testid': 'wizard-stub' }),
}));

vi.mock('@/features/billing/money', () => ({
  BILLING_CURRENCY: 'cny',
  formatBillingAmount: (amount: string, currency: string) => `${currency}:${amount}`,
}));

import { ProvidersSection } from '@/components/settings/ProvidersSection';

function makeXd(): ProviderView {
  return {
    id: 'xd',
    name: 'Cindy AI',
    source: 'builtin',
    agents: ['claude-code', 'codex'],
    auth: { method: 'managed' },
    routing: {},
    models: {
      'claude-code': [
        {
          id: 'cindy-test-model',
          name: 'Cindy Test Model',
          contextWindow: 200000,
          efforts: ['high'],
          defaultEffort: 'high',
        },
      ],
      codex: [],
    },
    connected: true,
  } as unknown as ProviderView;
}

function SearchProbe() {
  const location = useLocation();
  return <div data-testid="search">{`${location.pathname}${location.search}`}</div>;
}

function renderSection() {
  return render(
    <MemoryRouter initialEntries={['/settings?tab=providers']}>
      <Routes>
        <Route
          path="/settings"
          element={
            <>
              <ProvidersSection />
              <SearchProbe />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  providersState.order = [];
  providersState.providers = [makeXd()];
  authState.mode = 'cloud';
  authState.user = { membershipKind: 'personal' };
  authState.dataOwnerId = 'account-1';
  creditUsageState.available = '18.42';
  modelAccessState.state = 'ok';
  modelAccessState.source = 'server';
  modelAccessState.accountTier = null;
  apiKeyState.hasSavedKey = true;
  primaryActionState.value = 'buy-plan';
  primaryActionState.lastEnabled = false;
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    maker: {
      scanLocalCli: vi.fn(async () => ({ detections: [] })),
      requestProviderModelsAutoRefresh: vi.fn(async () => ({ ok: true })),
      setProviderOrder: vi.fn(async () => ({ ok: true })),
    },
    modelAccess: {
      retry: vi.fn(async () => undefined),
      rotate: vi.fn(async () => undefined),
    },
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ProvidersSection — Cindy AI 账户资产模块', () => {
  it('仅免费个人账号在 Cindy AI 模型数量后显示身份标签', async () => {
    modelAccessState.accountTier = 'free';
    renderSection();

    const badge = await screen.findByTestId('cindy-ai-free-tier-badge');
    expect(badge.textContent).toBe('settings.providers.xd.accountTier.free');
    const assetModule = screen.getByTestId('cindy-ai-asset-module');
    expect(assetModule.contains(badge)).toBe(false);
    expect(badge.previousElementSibling?.textContent).toBe('settings.providers.models.modelCount');
    expect(screen.getByTestId('provider-detail-metadata').contains(badge)).toBe(true);

    cleanup();
    modelAccessState.accountTier = 'paid';
    renderSection();
    await screen.findAllByText('settings.providers.xd.title');
    expect(screen.queryByTestId('cindy-ai-free-tier-badge')).toBeNull();

    cleanup();
    modelAccessState.accountTier = 'not_applicable';
    renderSection();
    await screen.findAllByText('settings.providers.xd.title');
    expect(screen.queryByTestId('cindy-ai-free-tier-badge')).toBeNull();
  });

  it('非套餐用户:查看用量始终在,右边购买套餐,不显示充值', async () => {
    renderSection();

    expect(await screen.findByText('billing.balance.title')).toBeTruthy();
    expect(screen.getByText('cny:18.42')).toBeTruthy();
    expect(primaryActionState.lastEnabled).toBe(true);

    fireEvent.click(screen.getByText('settings.providers.xd.asset.viewUsage'));
    await waitFor(() =>
      expect(screen.getByTestId('search').textContent).toBe('/settings?tab=billing'),
    );

    fireEvent.click(screen.getByText('settings.providers.xd.asset.buyPlan'));
    await waitFor(() =>
      expect(screen.getByTestId('search').textContent).toBe(
        '/settings?tab=billing&intent=subscribe',
      ),
    );

    const buyPlan = screen.getByText('settings.providers.xd.asset.buyPlan').closest('button');
    expect(buyPlan?.style.backgroundColor).toBe('var(--accent-cta-bg-pure)');
    expect(buyPlan?.style.color).toBe('var(--accent-pure-cta-fg)');
    const usageButton = screen.getByText('settings.providers.xd.asset.viewUsage').closest('button');
    expect(usageButton?.style.backgroundColor).toBe('var(--settings-btn-secondary-bg)');
    expect(usageButton?.style.color).toBe('var(--settings-btn-secondary-text)');
    expect(screen.queryByText('billing.settings.topupCard.action')).toBeNull();
    expect(screen.queryByText('settings.providers.xd.asset.upgradePlan')).toBeNull();

    const assetModule = screen.getByTestId('cindy-ai-asset-module');
    expect(assetModule.children).toHaveLength(2);
  });

  it('有套餐还能升级:查看用量始终在,右边升级套餐,不显示充值', async () => {
    primaryActionState.value = 'upgrade-plan';
    renderSection();

    expect(await screen.findByText('settings.providers.xd.asset.viewUsage')).toBeTruthy();
    expect(screen.getByText('settings.providers.xd.asset.upgradePlan')).toBeTruthy();
    expect(screen.queryByText('settings.providers.xd.asset.buyPlan')).toBeNull();
    expect(screen.queryByText('billing.settings.topupCard.action')).toBeNull();

    const upgrade = screen.getByText('settings.providers.xd.asset.upgradePlan').closest('button');
    expect(upgrade?.style.backgroundColor).toBe('var(--accent-cta-bg-pure)');
    expect(upgrade?.style.color).toBe('var(--accent-pure-cta-fg)');

    fireEvent.click(screen.getByText('settings.providers.xd.asset.upgradePlan'));
    await waitFor(() =>
      expect(screen.getByTestId('search').textContent).toBe(
        '/settings?tab=billing&intent=plan-change',
      ),
    );
  });

  it('升满以后:查看用量始终在,右边才是余额充值', async () => {
    primaryActionState.value = 'topup';
    renderSection();

    expect(await screen.findByText('settings.providers.xd.asset.viewUsage')).toBeTruthy();
    expect(screen.getByText('billing.settings.topupCard.action')).toBeTruthy();
    expect(screen.queryByText('settings.providers.xd.asset.buyPlan')).toBeNull();
    expect(screen.queryByText('settings.providers.xd.asset.upgradePlan')).toBeNull();

    const topup = screen.getByText('billing.settings.topupCard.action').closest('button');
    expect(topup?.style.backgroundColor).toBe('var(--accent-cta-bg-pure)');
    expect(topup?.style.color).toBe('var(--accent-pure-cta-fg)');

    fireEvent.click(screen.getByText('billing.settings.topupCard.action'));
    await waitFor(() =>
      expect(screen.getByTestId('search').textContent).toBe('/settings?tab=billing&intent=topup'),
    );
  });

  it('正常态版面上没有重试 / 轮换 / 重新获取凭据按钮(它们退进「···」菜单)', async () => {
    renderSection();

    await screen.findByText('billing.balance.title');
    expect(screen.queryByText('settings.providers.xd.sync.retry')).toBeNull();
    expect(screen.queryByText('settings.providers.xd.sync.rotate')).toBeNull();
    expect(screen.queryByText('settings.providers.xd.sync.refresh')).toBeNull();
    // 脱敏 key 也不在默认视图里。
    expect(screen.queryByText(/sk-/)).toBeNull();
    expect(screen.getByText('settings.providers.pill.connected')).toBeTruthy();
  });

  it('企业账号:整块资产模块不渲染,也不显示占位', async () => {
    authState.user = { membershipKind: 'org' };
    renderSection();

    await screen.findAllByText('settings.providers.xd.title');
    expect(screen.queryByText('billing.balance.title')).toBeNull();
    expect(screen.queryByText('cny:18.42')).toBeNull();
    expect(screen.queryByText('billing.settings.topupCard.action')).toBeNull();
  });

  it('local 会话(未登录云账号):同样不渲染', async () => {
    authState.mode = 'local';
    authState.user = null;
    renderSection();

    await screen.findAllByText('settings.providers.xd.title');
    expect(screen.queryByText('billing.balance.title')).toBeNull();
  });

  it('拿不到余额:不渲染余额区,不显示「—」占位', async () => {
    creditUsageState.available = null;
    renderSection();

    await screen.findAllByText('settings.providers.xd.title');
    expect(screen.queryByText('billing.balance.title')).toBeNull();
    expect(screen.queryByText('settings.providers.xd.asset.syncFailed')).toBeNull();
  });

  it('凭据同步失败:故障说明 + 重试,且不显示「已连接」', async () => {
    modelAccessState.state = 'failed';
    modelAccessState.source = null;
    renderSection();

    expect(await screen.findByText('settings.providers.xd.asset.syncFailed')).toBeTruthy();
    expect(screen.queryByText('settings.providers.pill.connected')).toBeNull();

    fireEvent.click(screen.getByText('settings.providers.xd.sync.retry'));
    await waitFor(() => expect(window.electronAPI.modelAccess.retry).toHaveBeenCalledOnce());
  });

  it('凭据管理三项与脱敏 key 都在「···」菜单里', async () => {
    renderSection();

    // Radix 的 DropdownMenuTrigger 走 pointerdown / 键盘,jsdom 下没有 PointerEvent,
    // 用键盘打开(与用户的键盘路径一致)。
    const providerIdentity = await screen.findByTestId('provider-detail-identity');
    const providerHeader = providerIdentity.parentElement;
    expect(providerHeader).not.toBeNull();
    fireEvent.keyDown(
      within(providerHeader!).getByLabelText('settings.providers.detail.moreActionsAria'),
      { key: 'Enter' },
    );

    expect(await screen.findByText('settings.providers.xd.sync.refresh')).toBeTruthy();
    expect(screen.getByText('settings.providers.xd.sync.rotate')).toBeTruthy();
    expect(screen.getByText('settings.providers.button.disconnect')).toBeTruthy();
    expect(screen.getByText('sk-••••••ef2a')).toBeTruthy();
    // 共用菜单里既有的供应商级动作不被挤掉。
    expect(screen.getByText('settings.providers.menu.disableProvider')).toBeTruthy();
  });
});
