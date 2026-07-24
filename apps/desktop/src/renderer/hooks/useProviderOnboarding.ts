/**
 * useProviderOnboarding — 「连接供应商」引导(首屏卡片 + 会话 banner)的唯一判定
 * 与数据装配点,两处 UI 都消费本 hook,防止判定口径漂移。
 *
 * 判定口径是**全局零已连接来源**(`providers.some(p => p.connected) === false`),
 * 而非 useConnectedSource 的 per-agent/per-model 口径:引导解决的是「一个可用模型
 * 都没有」的产品空态,模型级空态(选中模型无来源)由 ChatInput / ModelSelector
 * 自己处理,两层叙事不重复。
 *
 * 额度耗尽场景说明:Cindy 官方额度无客户端余额接口,只能在发送后由
 * providerErrors 分类为 QUOTA_EXCEEDED 感知;将来接入时在 `visible` 判定处
 * 叠加该信号即可,组件无需改动。
 */

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';

import { sortPresetsForLocale } from '@cindy/model-providers';
import type { ProviderPreset, ProviderView } from '@cindy/model-providers';
import { useTranslation } from 'react-i18next';

import { useAuth } from '@/contexts/AuthContext';
import { useProviders } from '@/hooks/useProviders';
import {
  dismissProviderOnboarding,
  isProviderOnboardingDismissed,
  resetProviderOnboardingDismissal,
  subscribeProviderOnboardingDismissal,
} from '@/state/providerOnboardingDismissal';

export interface UseProviderOnboardingReturn {
  /** 是否应展示引导:providers 已加载 && 零已连接来源 && 未被 dismiss。 */
  visible: boolean;
  loading: boolean;
  /** 登录三态:cloud 引导连接 Cindy AI;signed-out/local 引导去登录。 */
  authMode: 'signed-out' | 'local' | 'cloud';
  /** Cindy AI 官方供应商(恒在目录中;仅卡片推荐行消费)。 */
  xdProvider: ProviderView | undefined;
  /** 内置 OAuth 供应商行(anthropic → openai → xai,目录序)。 */
  oauthProviders: ProviderView[];
  /** 「其他供应商」折叠区的 API-key 预设(懒加载,失败为空数组)。 */
  presets: ProviderPreset[];
  dismiss: () => void;
}

interface UseProviderOnboardingOptions {
  /** 卡片需要预设目录时传 true(banner 不需要,省一次 IPC)。 */
  loadPresets?: boolean;
}

export function useProviderOnboarding(
  options?: UseProviderOnboardingOptions,
): UseProviderOnboardingReturn {
  const { i18n } = useTranslation();
  const { mode } = useAuth();
  const { providers, loading } = useProviders();

  const dismissed = useSyncExternalStore(
    subscribeProviderOnboardingDismissal,
    isProviderOnboardingDismissed,
  );

  const hasAnyConnected = useMemo(() => providers.some((p) => p.connected), [providers]);

  // 有供应商连上后清 dismiss:将来再次归零(登出/断开全部)时引导重新出现。
  useEffect(() => {
    if (!loading && hasAnyConnected) resetProviderOnboardingDismissal();
  }, [loading, hasAnyConnected]);

  const visible = !loading && !hasAnyConnected && !dismissed;

  const xdProvider = useMemo(() => providers.find((p) => p.id === 'xd'), [providers]);

  const oauthProviders = useMemo(
    () =>
      providers.filter((p) => p.source === 'builtin' && p.id !== 'xd' && p.auth.method === 'oauth'),
    [providers],
  );

  // 预设懒加载:仅在引导实际可见且调用方需要时拉取;失败静默空数组(折叠区整体不渲染)。
  const wantPresets = Boolean(options?.loadPresets) && visible;
  const [rawPresets, setRawPresets] = useState<ProviderPreset[] | null>(null);
  useEffect(() => {
    if (!wantPresets || rawPresets != null) return;
    let cancelled = false;
    void window.electronAPI.maker
      .listProviderPresets()
      .then((r) => {
        if (!cancelled) setRawPresets(r.presets);
      })
      .catch(() => {
        if (!cancelled) setRawPresets([]);
      });
    return () => {
      cancelled = true;
    };
  }, [wantPresets, rawPresets]);

  const presets = useMemo(
    () => (rawPresets ? sortPresetsForLocale(rawPresets, i18n.language) : []),
    [rawPresets, i18n.language],
  );

  return {
    visible,
    loading,
    authMode: mode,
    xdProvider,
    oauthProviders,
    presets,
    dismiss: dismissProviderOnboarding,
  };
}
