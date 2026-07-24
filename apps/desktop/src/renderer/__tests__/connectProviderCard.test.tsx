// @vitest-environment jsdom

/**
 * ConnectProviderCard — 零可用模型首屏引导卡关键不变量:
 *   1. 零已连接来源 → 渲染:Cindy AI 推荐行置顶 + 内置 OAuth 行(目录序);
 *      任一来源已连接 / loading 中 → 渲染 null,且连接后自动清 dismiss key。
 *   2. local(跳过登录)模式 → 推荐行变「登录 Cindy」,点击落 /login。
 *   3. 点 OAuth 行落 /settings?tab=providers&connect=<id>;「我有 API key」落 wizard=1;
 *      「其他供应商」展开后点预设行落 connect=<presetId>。
 *   4. dismiss → 卡片消失且 localStorage key 写入(与 banner 共享)。
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProviderView } from '@cindy/model-providers';

const { providersState, authState } = vi.hoisted(() => ({
  providersState: { providers: [] as unknown[], loading: false },
  authState: { mode: 'cloud' as string },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'zh-CN' } }),
}));

vi.mock('@/hooks/useProviders', () => ({
  useProviders: () => ({ ...providersState, refetch: vi.fn() }),
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => authState,
}));

vi.mock('@/lib/providerModels', () => ({
  providerMonogram: () => 'X',
}));

vi.mock('@/lib/providerSubtitle', () => ({
  providerSubtitleForDisplay: () => 'subtitle',
}));

vi.mock('@/components/icons/ProviderLogoMark', () => ({
  hasProviderLogo: () => false,
  ProviderLogoMark: () => null,
}));

import { ConnectProviderCard } from '@/components/onboarding/ConnectProviderCard';

function makeProvider(id: string, over?: Partial<ProviderView>): ProviderView {
  return {
    id,
    name: id,
    source: 'builtin',
    agents: ['claude-code'],
    auth: { method: 'oauth' },
    routing: {},
    models: { 'claude-code': [] },
    connected: false,
    ...over,
  } as unknown as ProviderView;
}

const baseProviders = [
  makeProvider('anthropic', { name: 'Anthropic' }),
  makeProvider('openai', { name: 'OpenAI' }),
  makeProvider('xai', { name: 'xAI' }),
  makeProvider('xd', { name: 'Cindy AI', auth: { method: 'managed' } as ProviderView['auth'] }),
];

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname + location.search}</div>;
}

function renderCard() {
  return render(
    <MemoryRouter initialEntries={['/cc-agent/new']}>
      <Routes>
        <Route
          path="*"
          element={
            <>
              <ConnectProviderCard />
              <LocationProbe />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

async function renderCardSettled() {
  const view = renderCard();
  // 等 presets 懒加载落定(othersToggle 出现),避免异步 setState 泄出 act()。
  await screen.findByText('onboarding.connectProvider.othersToggle');
  return view;
}

beforeEach(() => {
  providersState.providers = baseProviders;
  providersState.loading = false;
  authState.mode = 'cloud';
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    maker: {
      listProviderPresets: vi.fn(async () => ({
        presets: [
          {
            id: 'deepseek',
            name: 'DeepSeek',
            runtimes: { 'claude-code': { baseUrl: 'https://x' } },
          },
        ],
      })),
    },
  };
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.clearAllMocks();
});

describe('ConnectProviderCard', () => {
  it('零连接 → 渲染推荐行(Cindy AI)+ 三条 OAuth 行;点 Anthropic 落 connect=anthropic', async () => {
    await renderCardSettled();

    expect(screen.getByTestId('connect-provider-card')).not.toBeNull();
    expect(screen.getByText('Cindy AI')).not.toBeNull();
    expect(screen.getByText('onboarding.connectProvider.recommendedLabel')).not.toBeNull();
    expect(screen.getByText('Anthropic')).not.toBeNull();
    expect(screen.getByText('OpenAI')).not.toBeNull();
    expect(screen.getByText('xAI')).not.toBeNull();

    fireEvent.click(screen.getByText('Anthropic').closest('button')!);
    expect(screen.getByTestId('location').textContent).toBe(
      '/settings?tab=providers&connect=anthropic',
    );
  });

  it('cloud 模式点推荐行 → connect=xd;「我有 API key」→ wizard=1', async () => {
    await renderCardSettled();

    fireEvent.click(screen.getByText('Cindy AI').closest('button')!);
    expect(screen.getByTestId('location').textContent).toBe('/settings?tab=providers&connect=xd');

    cleanup();
    await renderCardSettled();
    fireEvent.click(screen.getByText('onboarding.connectProvider.haveApiKey').closest('button')!);
    expect(screen.getByTestId('location').textContent).toBe('/settings?tab=providers&wizard=1');
  });

  it('local(跳过登录)模式 → 推荐行为「登录 Cindy」,点击落 /login', async () => {
    authState.mode = 'local';
    await renderCardSettled();

    const loginRow = screen.getByText('onboarding.connectProvider.cindy.loginTitle');
    fireEvent.click(loginRow.closest('button')!);
    expect(screen.getByTestId('location').textContent).toBe('/login');
  });

  it('「其他供应商」懒加载预设,展开后点预设行落 connect=<presetId>', async () => {
    renderCard();

    const toggle = await screen.findByText('onboarding.connectProvider.othersToggle');
    fireEvent.click(toggle.closest('button')!);
    fireEvent.click(screen.getByText('DeepSeek').closest('button')!);
    expect(screen.getByTestId('location').textContent).toBe(
      '/settings?tab=providers&connect=deepseek',
    );
  });

  it('dismiss → 卡片消失且共享 key 写入', async () => {
    await renderCardSettled();

    fireEvent.click(screen.getByText('onboarding.connectProvider.dismiss'));
    expect(screen.queryByTestId('connect-provider-card')).toBeNull();
    expect(localStorage.getItem('providerOnboarding.dismissedAt')).not.toBeNull();
  });

  it('任一来源已连接 → 渲染 null,且自动清掉遗留 dismiss key;loading 中也不渲染', async () => {
    localStorage.setItem('providerOnboarding.dismissedAt', new Date().toISOString());
    providersState.providers = [
      ...baseProviders.slice(0, 3),
      makeProvider('xd', { name: 'Cindy AI', connected: true }),
    ];
    renderCard();

    expect(screen.queryByTestId('connect-provider-card')).toBeNull();
    await waitFor(() => expect(localStorage.getItem('providerOnboarding.dismissedAt')).toBeNull());

    cleanup();
    providersState.providers = [];
    providersState.loading = true;
    renderCard();
    expect(screen.queryByTestId('connect-provider-card')).toBeNull();
  });
});
