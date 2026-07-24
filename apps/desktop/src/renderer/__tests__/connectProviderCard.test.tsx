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

const { providersState, authState, regionState, detectState, exitLocalModeMock } = vi.hoisted(
  () => ({
    providersState: { providers: [] as unknown[], loading: false },
    authState: { mode: 'cloud' as string },
    regionState: { value: 'global' as string },
    detectState: { detections: [] as unknown[] },
    exitLocalModeMock: vi.fn(async () => undefined),
  }),
);

// 与 hook 内 `../../shared/brandRegion` 解析到同一模块(都落 src/shared/)。
vi.mock('../../shared/brandRegion', () => ({
  get CURRENT_CINDY_REGION() {
    return regionState.value;
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'zh-CN' } }),
}));

vi.mock('@/hooks/useProviders', () => ({
  useProviders: () => ({ ...providersState, refetch: vi.fn() }),
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ ...authState, exitLocalMode: exitLocalModeMock }),
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
import { resetProviderOnboardingDismissal } from '@/state/providerOnboardingDismissal';

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
  regionState.value = 'global';
  detectState.detections = [];
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    maker: {
      scanLocalCli: vi.fn(async () => ({ detections: detectState.detections })),
      listProviderPresets: vi.fn(async () => ({
        presets: [
          {
            id: 'deepseek',
            name: 'DeepSeek',
            runtimes: { 'claude-code': { baseUrl: 'https://x' } },
          },
          {
            id: 'zhipu-glm-cn',
            name: '智谱 GLM',
            regionHint: 'cn',
            runtimes: { 'claude-code': { baseUrl: 'https://y' } },
          },
          {
            id: 'kimi-cn',
            name: 'Kimi',
            regionHint: 'cn',
            runtimes: { 'claude-code': { baseUrl: 'https://z' } },
          },
        ],
      })),
    },
  };
});

afterEach(() => {
  cleanup();
  // 同时清 localStorage 与内存兜底态,防 dismiss 跨用例残留。
  resetProviderOnboardingDismissal();
  vi.clearAllMocks();
});

describe('ConnectProviderCard', () => {
  it('global 区零连接 → 推荐行(Cindy AI)+ 三条 OAuth 主列;点 Anthropic 落 connect=anthropic', async () => {
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

  it('检测到本机 CLI 已登录 → 该渠道置顶带徽标;只安装未登录不置顶,回落普通行', async () => {
    detectState.detections = [
      { cli: 'claude-cli', providerId: 'anthropic', installed: true, loggedIn: true },
      // 只安装未登录:装了 ≠ 有账号,不给「已检测到」待遇。
      { cli: 'codex-cli', providerId: 'openai', installed: true, loggedIn: false },
    ];
    await renderCardSettled();

    // 检测行:仅 Anthropic(已登录)置顶带徽标,副标题「已登录可直接授权」。
    expect(screen.getAllByText('onboarding.connectProvider.detectedLabel')).toHaveLength(1);
    expect(screen.getByText('settings.providers.detect.hintLoggedIn')).not.toBeNull();
    // 去重:Anthropic 只出现一次(检测行);OpenAI 留在普通 OAuth 主列(无徽标)。
    expect(screen.getAllByText('Anthropic')).toHaveLength(1);
    expect(screen.getAllByText('OpenAI')).toHaveLength(1);
    expect(screen.getByText('OpenAI').closest('button')!.textContent).not.toContain(
      'onboarding.connectProvider.detectedLabel',
    );

    // 检测行在推荐行(Cindy AI)之前。
    const card = screen.getByTestId('connect-provider-card');
    const labels = Array.from(card.querySelectorAll('button')).map((b) => b.textContent ?? '');
    expect(labels.findIndex((x) => x.includes('Anthropic'))).toBeLessThan(
      labels.findIndex((x) => x.includes('Cindy AI')),
    );

    fireEvent.click(screen.getByText('Anthropic').closest('button')!);
    expect(screen.getByTestId('location').textContent).toBe(
      '/settings?tab=providers&connect=anthropic',
    );
  });

  it('cn 区零连接 → 主列为国内预设,OAuth 三家收进折叠区;点预设行落 connect=<presetId>', async () => {
    regionState.value = 'cn';
    await renderCardSettled();

    // 主列:cn 预设;Anthropic 不在主列(折叠区未展开时不可见)。
    expect(screen.getByText('智谱 GLM')).not.toBeNull();
    expect(screen.getByText('Kimi')).not.toBeNull();
    expect(screen.queryByText('Anthropic')).toBeNull();

    fireEvent.click(screen.getByText('智谱 GLM').closest('button')!);
    expect(screen.getByTestId('location').textContent).toBe(
      '/settings?tab=providers&connect=zhipu-glm-cn',
    );

    cleanup();
    resetProviderOnboardingDismissal();
    await renderCardSettled();
    // 展开折叠区:OAuth 三家 + 非 cn 预设都在。
    fireEvent.click(screen.getByText('onboarding.connectProvider.othersToggle').closest('button')!);
    expect(screen.getByText('Anthropic')).not.toBeNull();
    expect(screen.getByText('OpenAI')).not.toBeNull();
    expect(screen.getByText('xAI')).not.toBeNull();
    expect(screen.getByText('DeepSeek')).not.toBeNull();
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
    // local 模式登录必须先 exitLocalMode(GuestRoute 对 local 一律弹回首页)再进 /login。
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/login'));
    expect(exitLocalModeMock).toHaveBeenCalledTimes(1);
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
