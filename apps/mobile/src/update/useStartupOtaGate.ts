// 启动 JS 热更闸门 hook:冷启动时跑一次 runStartupOtaUpdate,期间返回 ready=false 让调用方渲染
// loading 门(避免先显示旧 UI 再 reload 的闪帧)。gate 不满足(非自建 / dev / updates 不可用)时
// 直接 ready=true,不阻塞、不发起任何网络。判定逻辑在 startupOtaUpdate.ts(纯函数、已单测)。

import { useCallback, useEffect, useRef, useState } from 'react';
import * as Updates from 'expo-updates';
import { IS_OTA_SELFHOST, OTA_SERVER_BASE_URL, REVIEW_MODE } from '@/config/env';
import {
  runEmergencyOtaRecovery,
  runStartupOtaUpdate,
  type StartupOtaOutcome,
} from './startupOtaUpdate';
import { updateChannelRequestHeaders } from './canaryChannelStore';
import type { UpdateChannel } from '@cindy/maker-shared/update-channel';
import {
  clearOtaReloadGuardIfLaunched,
  readOtaReloadGuard,
  recordOtaReload,
  shouldBlockOtaReload,
} from './otaReloadGuard';

/**
 * 启动闸门链全部走完(业务树可用)后调用:只有当次 reload 的目标 update 确实成为当前
 * 运行版本时才清闸门记录。放在这里而不是热更门放行处——被闸门拦下也会放行进 App,
 * 那时清记录等于每次冷启动都重新放开一次 reload,循环只会变成「每启动闪一轮」。
 */
export function markStartupOtaLaunchSuccess(): void {
  void clearOtaReloadGuardIfLaunched(Updates.updateId);
}

/**
 * 启动时把「本次跑的是哪份 JS」钉进日志流。
 *
 * 曾经排查一台无限转圈的设备时,客户端一行相关日志都没有,只能靠原生 dev.expo.updates
 * 日志反推当前启动的是包内 bundle 还是热更包。这一行让同类问题一眼可判,
 * 沿用 mobile 既有 `console.*` + `[tag]` 前缀约定。
 */
function logStartupOtaLaunch(outcome: StartupOtaOutcome): void {
  console.info(
    '[ota] startup gate',
    JSON.stringify({
      outcome,
      updateId: Updates.updateId,
      isEmbeddedLaunch: Updates.isEmbeddedLaunch,
      isEmergencyLaunch: Updates.isEmergencyLaunch,
      emergencyLaunchReason: Updates.emergencyLaunchReason,
      createdAt: Updates.createdAt?.toISOString() ?? null,
      runtimeVersion: Updates.runtimeVersion,
    }),
  );
}

export function useStartupOtaGate(channel: UpdateChannel = 'release'): boolean {
  // 仅自建变体 + 非 dev + expo-updates 运行时可用才走热更门;其余一律直接放行。
  // 审核模式(清单 review 送审版本号命中当前二进制版本)本门关闭:启动不走 JS
  // 显式 check→fetch→reload,直接进主界面(expo-updates 原生层的后台静默检查是
  // build-time 配置,不受此字段控制,边界见 maker-shared clientEndpoints 的
  // CLIENT_ENDPOINT_REVIEW_KEY)。REVIEW_MODE 是 live binding,本 hook 挂载在
  // 端点闸门 ready 之后,读到的必是清单匹配结果。
  const enabled = IS_OTA_SELFHOST && !__DEV__ && Updates.isEnabled && !REVIEW_MODE;
  const [ready, setReady] = useState(!enabled);
  const started = useRef(false);
  const configuredChannelRef = useRef<UpdateChannel | null>(null);

  const configureUpdateUrl = useCallback(() => {
    if (!OTA_SERVER_BASE_URL) {
      throw new Error('endpoint manifest missing mobileUpdateBaseUrl');
    }
    Updates.setUpdateURLAndRequestHeadersOverride({
      updateUrl: `${OTA_SERVER_BASE_URL}/manifest`,
      requestHeaders: updateChannelRequestHeaders(channel),
    });
    configuredChannelRef.current = channel;
  }, [channel]);

  // feature-flags 在登录/切账号后可能更新 channel；启动检查只跑一次，但
  // expo-updates 仍必须马上切换 request header，否则本进程会把下一个账号
  // 的请求发到上一个账号的 canary/stable 指针。stable 的空 header 也会
  // 覆盖掉之前的 canary header。
  useEffect(() => {
    if (!enabled || configuredChannelRef.current === channel) return;
    try {
      configureUpdateUrl();
    } catch {
      // 真正的启动检查会把配置异常按 fail-open 处理；这里仅提前同步配置，
      // 失败不能阻断主界面或后续重试。
    }
  }, [configureUpdateUrl, enabled, channel]);

  useEffect(() => {
    if (!enabled || started.current) return;
    started.current = true; // 只冷启一次(不随 resume 重跑)
    let cancelled = false;
    const otaDeps = {
      enabled,
      configureUpdateUrl,
      checkForUpdateAsync: () => Updates.checkForUpdateAsync(),
      fetchUpdateAsync: () => Updates.fetchUpdateAsync(),
      reloadAsync: () => Updates.reloadAsync(),
      isEmergencyLaunch: () => Updates.isEmergencyLaunch,
      currentUpdateId: () => Updates.updateId,
      isReloadBlocked: async (targetUpdateId: string) =>
        shouldBlockOtaReload(await readOtaReloadGuard(), targetUpdateId),
      recordReload: recordOtaReload,
    };
    void runStartupOtaUpdate(otaDeps).then((outcome) => {
      logStartupOtaLaunch(outcome);
      // emergency launch:门已放行,修复版热更改在后台找(绝不 reload,见
      // runEmergencyOtaRecovery)。fire-and-forget——它的结果不影响本次启动,
      // 只是让下一次冷启动有机会跑上修复版,而不是等用户去清应用数据。
      if (outcome === 'emergency-launch') {
        void runEmergencyOtaRecovery(otaDeps).then((recovery) => {
          console.info('[ota] emergency recovery', JSON.stringify({ recovery }));
        });
      }
      // 'reloading' 时 app 正在重启,保持 loading 门直到重启;其余情况放行进 App。
      if (!cancelled && outcome !== 'reloading') setReady(true);
    }).catch(() => {
      logStartupOtaLaunch('error');
      // runStartupOtaUpdate 设计为永不 reject;万一意外 reject,兜底 fail-open 放行,
      // 否则 loading 门会永久卡住且不可自恢复(后续 OTA 也进不来),与全模块 fail-open 一致。
      if (!cancelled) setReady(true);
    });
    return () => { cancelled = true; };
  }, [configureUpdateUrl, enabled]);

  return ready;
}
