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
import { subscribeProvidersSnapshot } from '@/lib/providersSnapshotStore';
import { CURRENT_CINDY_REGION } from '../../shared/brandRegion';
import type { LocalCliDetection } from '../../shared/localCliDetect';
import {
  dismissProviderOnboarding,
  isProviderOnboardingDismissed,
  resetProviderOnboardingDismissal,
  subscribeProviderOnboardingDismissal,
} from '@/state/providerOnboardingDismissal';

// 模块级订阅:任一供应商连上即清 dismiss,不依赖引导 UI 是否挂载——用户在设置页
// 连上又断开、期间从未回到首屏/会话视图时,dismiss 也必须被清,否则回到零连接后
// 引导永远不再出现(Codex P1,2026-07-24)。与 hook 内 effect 并存:effect 覆盖
// 挂载中的即时清理(含测试 mock 场景),此处覆盖未挂载窗口;reset 为幂等 no-op。
const unsubscribeAutoReset = subscribeProvidersSnapshot((snapshot) => {
  if (snapshot?.providers.some((p) => p.connected)) resetProviderOnboardingDismissal();
});
// HMR 下本模块会被重复执行:不 dispose 会累积 listener(reset 幂等,功能无害,
// 但 dev 长跑会泄漏)。生产构建无 import.meta.hot,整段被摇树掉。
if (import.meta.hot) {
  import.meta.hot.dispose(() => unsubscribeAutoReset());
}

/** 引导卡一行:内置渠道(OAuth)或 API-key 预设,统一由卡片渲染。 */
export type ProviderOnboardingRow =
  { kind: 'builtin'; provider: ProviderView } | { kind: 'preset'; preset: ProviderPreset };

/** 本机 CLI 检测行:该渠道大概率是用户现有生态,置于全卡最顶(优先于推荐行)。 */
export interface DetectedProviderRow {
  provider: ProviderView;
  detection: LocalCliDetection;
}

export interface UseProviderOnboardingReturn {
  /** 是否应展示引导:providers 已加载 && 零已连接来源 && 未被 dismiss。 */
  visible: boolean;
  loading: boolean;
  /** 登录三态:cloud 引导连接 Cindy AI;signed-out/local 引导去登录。 */
  authMode: 'signed-out' | 'local' | 'cloud';
  /** Cindy AI 官方供应商(恒在目录中;仅卡片推荐行消费)。 */
  xdProvider: ProviderView | undefined;
  /**
   * 本机 CLI 检测行:**仅限已有登录态凭证**(installed && loggedIn)且对应渠道
   * 未连接——有凭证才意味着一键授权大概率直接成功,配得上排在最顶(优先于
   * Cindy 推荐行)。只安装未登录不置顶(装了 ≠ 有账号,2026-07-24 用户反馈),
   * 该渠道回落为主列/折叠区的普通 OAuth 行。
   */
  detectedRows: DetectedProviderRow[];
  /**
   * 主列表行,按构建区域装配(CN 版首推海外订阅渠道不合理,2026-07-24 用户反馈):
   *   - cn:regionHint=cn 的预设(智谱/Kimi/MiniMax/百炼…,最多 4 行;目录异常
   *     取不到 cn 预设时回落 OAuth 行);Anthropic/OpenAI/xAI 收进折叠区。
   *   - global:内置 OAuth 行(anthropic → openai → xai,目录序);预设收折叠区。
   */
  primaryRows: ProviderOnboardingRow[];
  /** 「其他供应商」折叠区行(主列表之外的全部选项)。 */
  moreRows: ProviderOnboardingRow[];
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

  // 预设与本机 CLI 检测懒加载:仅在引导实际可见且调用方需要时拉取;失败静默空数组
  // (折叠区/检测行是增强,不是依赖)。
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

  const [detections, setDetections] = useState<LocalCliDetection[] | null>(null);
  useEffect(() => {
    if (!wantPresets || detections != null) return;
    let cancelled = false;
    void window.electronAPI.maker
      .scanLocalCli()
      .then((r) => {
        if (!cancelled) setDetections(r.detections);
      })
      .catch(() => {
        if (!cancelled) setDetections([]);
      });
    return () => {
      cancelled = true;
    };
  }, [wantPresets, detections]);

  const detectedRows = useMemo<DetectedProviderRow[]>(() => {
    if (!detections) return [];
    return detections
      .filter((d) => d.installed && d.loggedIn)
      .map((detection) => ({
        detection,
        provider: providers.find((p) => p.id === detection.providerId),
      }))
      .filter((r): r is DetectedProviderRow => !!r.provider && !r.provider.connected);
  }, [detections, providers]);

  const presets = useMemo(
    () => (rawPresets ? sortPresetsForLocale(rawPresets, i18n.language) : []),
    [rawPresets, i18n.language],
  );

  // 主列/折叠区装配(区域策略见 UseProviderOnboardingReturn.primaryRows 注释)。
  // 已被检测行占位的渠道从两区剔除,不重复出现。
  const { primaryRows, moreRows } = useMemo(() => {
    const detectedIds = new Set(detectedRows.map((r) => r.provider.id));
    const oauthRows: ProviderOnboardingRow[] = oauthProviders
      .filter((p) => !detectedIds.has(p.id))
      .map((provider) => ({
        kind: 'builtin' as const,
        provider,
      }));
    const presetRows: ProviderOnboardingRow[] = presets.map((preset) => ({
      kind: 'preset',
      preset,
    }));
    if (CURRENT_CINDY_REGION === 'cn') {
      // presets 未落定(本地 IPC,毫秒级)前主列留空,避免先闪 OAuth 再换预设。
      if (rawPresets == null) return { primaryRows: [], moreRows: [] };
      const cnPresets = presetRows.filter(
        (r) => r.kind === 'preset' && r.preset.regionHint === 'cn',
      );
      const primary = cnPresets.slice(0, 4);
      if (primary.length === 0) {
        // 目录异常(载入失败/无 cn 预设)兜底:退回 OAuth 主列,不留空列表。
        return { primaryRows: oauthRows, moreRows: presetRows };
      }
      const inPrimary = new Set(primary.map((r) => (r.kind === 'preset' ? r.preset.id : '')));
      return {
        primaryRows: primary,
        // 折叠区:OAuth 三家在前(知名度高),其余预设随后。
        moreRows: [
          ...oauthRows,
          ...presetRows.filter((r) => r.kind === 'preset' && !inPrimary.has(r.preset.id)),
        ],
      };
    }
    return { primaryRows: oauthRows, moreRows: presetRows };
  }, [oauthProviders, presets, rawPresets, detectedRows]);

  return {
    visible,
    loading,
    authMode: mode,
    xdProvider,
    detectedRows,
    primaryRows,
    moreRows,
    dismiss: dismissProviderOnboarding,
  };
}
