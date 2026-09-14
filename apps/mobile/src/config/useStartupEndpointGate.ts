// 启动端点清单闸门 hook:冷启动时跑 runStartupEndpointResolve,成功前业务树
// 不挂载。正式包只认 CDN 清单:字段缺失/空白允许放行;拉取失败、JSON/schema
// 无法解析或非空值非法时进入 error 态,由 _layout 渲染错误屏,用户点重试再跑一次;
// 无包内回退。
// __DEV__ 默认放行(零网络,端点初值来自仓内 config/endpoint.json,见 env.ts);
// EXPO_PUBLIC_ENDPOINTS_CDN=1 时 dev 也走完整 CDN 闸门(测线上清单,与
// desktop 的 --endpoints-cdn 同语义)。
// 时序:本闸门必须先于 OTA 检查更新(_layout 只在 ready 后挂载 OTA 门)。

import { useCallback, useEffect, useRef, useState } from 'react';

import { isTestFlightBuild } from '@/platform/appDistribution';
import { runStartupEndpointResolve } from './clientEndpointStartup';
import {
  BUILD_AUTH_REGION,
  DEV_RELEASE_ENDPOINT_MANIFEST_BASE_URL,
  ENDPOINT_MANIFEST_BASE_URL,
  resolveEnvFlag,
} from './env';
import {
  DEV_SERVER_ENVIRONMENT_SWITCH_ENABLED,
  buildDevServerEndpointStartupSteps,
  hydrateDevServerEnvironment,
  runDevServerEndpointStartupSteps,
  setDevServerEnvironment,
} from './devServerEnvironment';

export type StartupEndpointGateStatus = 'pending' | 'ready' | 'error';

export interface StartupEndpointGate {
  status: StartupEndpointGateStatus;
  /** status === 'error' 时的失败原因(fetch-failed / invalid-json / ...)。 */
  reason: string | null;
  /** Release 业务端点覆盖失败时，唯一动作可将 CindyDev 恢复到 Dev。 */
  canResetToDev: boolean;
  /** 清除 Release 选择后重新执行启动闸门。 */
  resetToDev: () => void;
  /** 错误屏「重试」:回到 pending 并重新拉取。 */
  retry: () => void;
}

export function useStartupEndpointGate(): StartupEndpointGate {
  const defaultEndpointGateEnabled =
    !__DEV__ || resolveEnvFlag(process.env.EXPO_PUBLIC_ENDPOINTS_CDN);
  const enabled =
    defaultEndpointGateEnabled || DEV_SERVER_ENVIRONMENT_SWITCH_ENABLED;
  const [status, setStatus] = useState<StartupEndpointGateStatus>(
    enabled ? 'pending' : 'ready',
  );
  const [reason, setReason] = useState<string | null>(null);
  const [canResetToDev, setCanResetToDev] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const running = useRef(false);

  useEffect(() => {
    if (!enabled || status === 'ready' || running.current) return;
    if (status === 'error') return; // 等用户点重试
    running.current = true;
    let cancelled = false;
    void (async () => {
      const environment = DEV_SERVER_ENVIRONMENT_SWITCH_ENABLED
        ? await hydrateDevServerEnvironment()
        : 'dev';
      const steps = buildDevServerEndpointStartupSteps({
        buildManifestBaseUrl: ENDPOINT_MANIFEST_BASE_URL,
        defaultEndpointGateEnabled,
        environment,
        releaseManifestBaseUrl: DEV_RELEASE_ENDPOINT_MANIFEST_BASE_URL,
        switchEnabled: DEV_SERVER_ENVIRONMENT_SWITCH_ENABLED,
      });
      return runDevServerEndpointStartupSteps(steps, (step) =>
        runStartupEndpointResolve({
          expectedRegion: BUILD_AUTH_REGION,
          manifestBaseUrl: step.manifestBaseUrl,
          preserveBuildReleaseMetadata: step.preserveBuildReleaseMetadata,
          resolveIsTestFlight: isTestFlightBuild,
        }),
      );
    })().then((outcome) => {
      running.current = false;
      if (cancelled) return;
      if (outcome.ok) {
        setCanResetToDev(false);
        setStatus('ready');
      } else {
        setReason(outcome.reason);
        setCanResetToDev(outcome.canResetToDev);
        setStatus('error');
      }
    });
    return () => {
      cancelled = true;
    };
  }, [defaultEndpointGateEnabled, enabled, status, attempt]);

  const retry = useCallback(() => {
    setReason(null);
    setCanResetToDev(false);
    setStatus('pending');
    setAttempt((n) => n + 1);
  }, []);

  const resetToDev = useCallback(() => {
    if (running.current) return;
    running.current = true;
    setReason(null);
    setCanResetToDev(false);
    setStatus('pending');
    void setDevServerEnvironment('dev')
      .then(() => {
        running.current = false;
        setAttempt((n) => n + 1);
      })
      .catch(() => {
        running.current = false;
        setReason('environment-reset-failed');
        setCanResetToDev(true);
        setStatus('error');
      });
  }, []);

  return { status, reason, canResetToDev, resetToDev, retry };
}
