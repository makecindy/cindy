// 阻断屏的"回前台重新核对" hook:订阅 AppState,把真实 IO 绑进
// createForcedUpdateRechecker(判定/节流逻辑在 forcedUpdateRecheck.ts,纯函数已单测)。
//
// 只在强更阻断屏挂载期间存在(见 app/_layout.tsx 的 ForcedUpdateGateContent):
// 阻断态解除后业务树重新挂载,后续检查回到 useResumeUpdateCheck 那条常规通道。

import { useEffect } from 'react';
import { AppState, Platform } from 'react-native';
import Constants from 'expo-constants';
import * as Updates from 'expo-updates';
import { fetchLatestRelease } from './fetchLatestRelease';
import { createForcedUpdateRechecker } from './forcedUpdateRecheck';
import {
  clearForcedUpdate,
  enterForcedUpdate,
  getForcedUpdateRevision,
  getForcedUpdateTarget,
} from './forcedUpdateStore';
import { isCanaryChannel } from './canaryChannelStore';

/** 定时敲门间隔;真实请求频率仍由核对器内部节流决定(默认 30s)。 */
const RECHECK_TICK_MS = 30_000;

export function useForcedUpdateRecheck(isCanary = isCanaryChannel()): void {
  useEffect(() => {
    let current = true;
    const rechecker = createForcedUpdateRechecker({
      fetchLatest: () => fetchLatestRelease(
        Platform.OS === 'android' ? 'android' : 'ios',
        undefined,
        undefined,
        isCanary,
      ),
      getCurrentRuntimeVersion: () => Updates.runtimeVersion,
      getCurrentVersion: () => Constants.expoConfig?.version ?? null,
      onCleared: clearForcedUpdate,
      // 仍强更时刷新目标(等值时 enterForcedUpdate 幂等,不会引发重渲染)。
      onStillForced: enterForcedUpdate,
      // compare-and-set:核对期间若有更新的观察写入 store,本次旧结论作废。
      getRevision: getForcedUpdateRevision,
      // 新鲜度门:CDN 边缘可能返回比当前阻断目标更旧的记录,那种记录不得用来解除。
      getHeldTarget: getForcedUpdateTarget,
      now: () => Date.now(),
      isCurrent: () => current,
      // 阻断态可能在 App 已切后台后才被置位(检查的 /latest 迟到返回),
      // 那时本实例见不到 'background' 事件;这里补种当前状态。
      getAppState: () => AppState.currentState,
    });

    const subscription = AppState.addEventListener('change', (next) => {
      void rechecker.handleAppStateChange(next);
    });
    // 定时兜底:光靠 AppState 跳变不够 —— 用户就停在阻断屏上不动时没有任何跳变,
    // 而在后台被置位又在节流窗口内回前台的那次 'active' 也会被节流丢掉。
    // 实际请求频率由核对器内部节流(默认 30s)决定,这里只负责按时敲门。
    const timer = setInterval(() => {
      // 只在前台敲门:部分平台 / 配置下定时器在后台仍会触发,那会白发 /latest
      // (耗电 + 无谓的后台网络)。回前台那一刻由 AppState 通道负责,
      // 定时兜底只需要覆盖"用户停在前台的阻断屏上、没有任何跳变"这一种场景。
      if (AppState.currentState !== 'active') return;
      void rechecker.handleTick();
    }, RECHECK_TICK_MS);
    return () => {
      current = false;
      subscription.remove();
      clearInterval(timer);
    };
  }, [isCanary]);
}
