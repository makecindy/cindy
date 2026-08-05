// 启动 JS 热更闸门 hook:冷启动时跑一次 runStartupOtaUpdate,期间返回 ready=false 让调用方渲染
// loading 门(避免先显示旧 UI 再 reload 的闪帧)。gate 不满足(非自建 / dev / updates 不可用)时
// 直接 ready=true,不阻塞、不发起任何网络。判定逻辑在 startupOtaUpdate.ts(纯函数、已单测)。

import { useCallback, useEffect, useRef, useState } from 'react';
import * as Updates from 'expo-updates';
import { IS_OTA_SELFHOST, OTA_SERVER_BASE_URL, REVIEW_MODE } from '@/config/env';
import { runStartupOtaUpdate } from './startupOtaUpdate';
import { updateChannelRequestHeaders } from './canaryChannelStore';

export function useStartupOtaGate(isCanary = false): boolean {
  // 仅自建变体 + 非 dev + expo-updates 运行时可用才走热更门;其余一律直接放行。
  // 审核模式(清单 review 送审版本号命中当前二进制版本)本门关闭:启动不走 JS
  // 显式 check→fetch→reload,直接进主界面(expo-updates 原生层的后台静默检查是
  // build-time 配置,不受此字段控制,边界见 maker-shared clientEndpoints 的
  // CLIENT_ENDPOINT_REVIEW_KEY)。REVIEW_MODE 是 live binding,本 hook 挂载在
  // 端点闸门 ready 之后,读到的必是清单匹配结果。
  const enabled = IS_OTA_SELFHOST && !__DEV__ && Updates.isEnabled && !REVIEW_MODE;
  const [ready, setReady] = useState(!enabled);
  const started = useRef(false);
  const configuredChannelRef = useRef<boolean | null>(null);

  const configureUpdateUrl = useCallback(() => {
    if (!OTA_SERVER_BASE_URL) {
      throw new Error('endpoint manifest missing mobileUpdateBaseUrl');
    }
    Updates.setUpdateURLAndRequestHeadersOverride({
      updateUrl: `${OTA_SERVER_BASE_URL}/manifest`,
      requestHeaders: updateChannelRequestHeaders(isCanary),
    });
    configuredChannelRef.current = isCanary;
  }, [isCanary]);

  // feature-flags 在登录/切账号后可能更新 channel；启动检查只跑一次，但
  // expo-updates 仍必须马上切换 request header，否则本进程会把下一个账号
  // 的请求发到上一个账号的 canary/stable 指针。stable 的空 header 也会
  // 覆盖掉之前的 canary header。
  useEffect(() => {
    if (!enabled || configuredChannelRef.current === isCanary) return;
    try {
      configureUpdateUrl();
    } catch {
      // 真正的启动检查会把配置异常按 fail-open 处理；这里仅提前同步配置，
      // 失败不能阻断主界面或后续重试。
    }
  }, [configureUpdateUrl, enabled, isCanary]);

  useEffect(() => {
    if (!enabled || started.current) return;
    started.current = true; // 只冷启一次(不随 resume 重跑)
    let cancelled = false;
    void runStartupOtaUpdate({
      enabled,
      configureUpdateUrl,
      checkForUpdateAsync: () => Updates.checkForUpdateAsync(),
      fetchUpdateAsync: () => Updates.fetchUpdateAsync(),
      reloadAsync: () => Updates.reloadAsync(),
    }).then((outcome) => {
      // 'reloading' 时 app 正在重启,保持 loading 门直到重启;其余情况放行进 App。
      if (!cancelled && outcome !== 'reloading') setReady(true);
    }).catch(() => {
      // runStartupOtaUpdate 设计为永不 reject;万一意外 reject,兜底 fail-open 放行,
      // 否则 loading 门会永久卡住且不可自恢复(后续 OTA 也进不来),与全模块 fail-open 一致。
      if (!cancelled) setReady(true);
    });
    return () => { cancelled = true; };
  }, [configureUpdateUrl, enabled]);

  return ready;
}
