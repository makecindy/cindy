// resume(后台切回前台)静默更新检查 hook:订阅 AppState,把真实 IO 绑进
// createResumeUpdateChecker(判定/节流逻辑在 resumeUpdateCheck.ts,纯函数已单测)。
//
// 挂载点 app/_layout.tsx。非自建变体(IS_OTA_SELFHOST=false)完全 no-op:不订阅、不发起
// 任何网络。JS OTA 部分与启动热更门同 gate(自建 + 非 dev + expo-updates 可用);整包
// 检查部分与 useBundleUpdatePrompt 同 gate(自建 + 非审核 + 非 TestFlight)。

import { useEffect } from 'react';
import { AppState, Platform } from 'react-native';
import * as Updates from 'expo-updates';
import {
  APP_BINARY_VERSION,
  IS_OTA_SELFHOST,
  IS_TESTFLIGHT_BUILD,
  REVIEW_MODE,
} from '@/config/env';
import { shouldCheckBundleUpdate } from './bundleUpdate';
import { fetchLatestRelease } from './fetchLatestRelease';
import { createResumeUpdateChecker } from './resumeUpdateCheck';
import { promptBundleUpdate } from './useBundleUpdatePrompt';
import { resolveUpdateChannelForDevice } from './canaryChannelStore';
import { runSelfHostedOtaRequest } from './otaRequestCoordinator';
import type { UpdateChannel } from '@cindy/maker-shared/update-channel';

export function useResumeUpdateCheck(
  channel: UpdateChannel = resolveUpdateChannelForDevice(),
): void {
  const bundleCheckEnabled = shouldCheckBundleUpdate({
    isSelfHosted: IS_OTA_SELFHOST,
    isReviewMode: REVIEW_MODE,
    isTestFlightBuild: IS_TESTFLIGHT_BUILD,
  });

  useEffect(() => {
    if (!IS_OTA_SELFHOST) return; // 非自建变体无静默更新通道,连 AppState 都不订阅
    if (REVIEW_MODE) return; // 审核模式:关闭本 hook 的 resume 静默检查,不订阅 AppState

    let current = true;
    const checker = createResumeUpdateChecker({
      otaEnabled: IS_OTA_SELFHOST && !__DEV__ && Updates.isEnabled,
      withOtaClient: (operation) => runSelfHostedOtaRequest(channel, operation),
      checkForUpdateAsync: () => Updates.checkForUpdateAsync(),
      fetchUpdateAsync: () => Updates.fetchUpdateAsync(),
      bundleCheckEnabled,
      fetchLatest: () => fetchLatestRelease(
        Platform.OS === 'android' ? 'android' : 'ios',
        undefined,
        undefined,
        channel,
      ),
      getCurrentRuntimeVersion: () => Updates.runtimeVersion,
      // 与 useBundleUpdatePrompt / useForcedUpdateRecheck 同口径:强更比较按原生真值,热更后不漂移。
      getCurrentVersion: () => APP_BINARY_VERSION || null,
      onForcedUpdate: promptBundleUpdate,
      now: () => Date.now(),
      isCurrent: () => current,
    });

    const subscription = AppState.addEventListener('change', (next) => {
      void checker.handleAppStateChange(next);
    });
    return () => {
      current = false;
      subscription.remove();
    };
  }, [bundleCheckEnabled, channel]);
}
