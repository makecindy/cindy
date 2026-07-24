// @vitest-environment jsdom

/**
 * ConnectProviderBanner — 会话内零可用模型引导条关键不变量:
 *   1. 与首屏卡片同判定:零已连接来源才渲染;有连接 → null。
 *   2. CTA 按登录态分派:cloud → /settings?tab=providers;local → /login。
 *   3. dismiss 与卡片共享同一 key:banner 上点 X,key 写入(两处一起消失)。
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
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

import { ConnectProviderBanner } from '@/components/onboarding/ConnectProviderBanner';
import { dismissProviderOnboarding } from '@/state/providerOnboardingDismissal';

const disconnectedXd = {
  id: 'xd',
  name: 'Cindy AI',
  source: 'builtin',
  agents: ['claude-code', 'codex'],
  auth: { method: 'managed' },
  routing: {},
  models: { 'claude-code': [], codex: [] },
  connected: false,
} as unknown as ProviderView;

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname + location.search}</div>;
}

function renderBanner() {
  return render(
    <MemoryRouter initialEntries={['/cc-agent/session/1']}>
      <Routes>
        <Route
          path="*"
          element={
            <>
              <ConnectProviderBanner />
              <LocationProbe />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  providersState.providers = [disconnectedXd];
  providersState.loading = false;
  authState.mode = 'cloud';
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.clearAllMocks();
});

describe('ConnectProviderBanner', () => {
  it('零连接 + cloud → 渲染,CTA 落 /settings?tab=providers', () => {
    renderBanner();

    expect(screen.getByTestId('connect-provider-banner')).not.toBeNull();
    fireEvent.click(screen.getByText('onboarding.connectProvider.banner.connectCta'));
    expect(screen.getByTestId('location').textContent).toBe('/settings?tab=providers');
  });

  it('local 模式 CTA 变登录,落 /login', () => {
    authState.mode = 'local';
    renderBanner();

    fireEvent.click(screen.getByText('onboarding.connectProvider.banner.loginCta'));
    expect(screen.getByTestId('location').textContent).toBe('/login');
  });

  it('有已连接来源 → 渲染 null', () => {
    providersState.providers = [{ ...disconnectedXd, connected: true } as unknown as ProviderView];
    renderBanner();

    expect(screen.queryByTestId('connect-provider-banner')).toBeNull();
  });

  it('X dismiss 写共享 key;卡片侧 dismiss 也会让 banner 消失(同 key 同订阅)', () => {
    renderBanner();

    fireEvent.click(screen.getByLabelText('onboarding.connectProvider.banner.dismissAria'));
    expect(screen.queryByTestId('connect-provider-banner')).toBeNull();
    expect(localStorage.getItem('providerOnboarding.dismissedAt')).not.toBeNull();

    cleanup();
    localStorage.clear();
    renderBanner();
    expect(screen.getByTestId('connect-provider-banner')).not.toBeNull();
    // 模拟另一处(首屏卡片)dismiss:同一 store 通知,banner 立即消失。
    act(() => dismissProviderOnboarding());
    expect(screen.queryByTestId('connect-provider-banner')).toBeNull();
  });
});
