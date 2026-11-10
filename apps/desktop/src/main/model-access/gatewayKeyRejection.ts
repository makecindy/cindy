import { keyFingerprint, createGatewayKeyRejectionReporter, bearerKeyFromHeaders, type GatewayKeyRejectionReporter } from './gatewayKeyRejectionCore.js';
export { CINDY_KEY_REJECTION_RETRIGGER_WINDOW_MS, createGatewayKeyRejectionReporter, bearerKeyFromHeaders, type GatewayKeyRejectionDeps, type GatewayKeyRejectionReporter } from './gatewayKeyRejectionCore.js';

import { isProviderDisabled } from '@cindy/model-providers';

import type { ModelAccessCredentialSource } from '../../shared/modelAccess.js';
import { getAppCapabilities } from '../appCapabilities.js';
import { isAppSessionBoundaryPending } from '../appSessionState.js';
import { createLogger } from '../logger.js';
import { readModelDisableOverrides } from '../maker-host/model-disable-store.js';
import { addProviderSecretsClearedListener, getProviderSecretStore } from '../secrets/providerSecretStore.js';
import { getModelAccessCredentialsStore } from './credentialsStore.js';

// Only keys actually replaced during this app run are eligible for Codex proxy repair.
// Keep fingerprints, never credentials; owner changes invalidate the entire history.
const replacedGatewayKeyFingerprints = new Set<string>();
let historyClearListenerInstalled = false;

export function noteCindyGatewayKeyReplaced(previousKey: string | null, nextKey: string): void {
  if (!previousKey || !nextKey || previousKey === nextKey || isAppSessionBoundaryPending()) return;
  if (!historyClearListenerInstalled) {
    addProviderSecretsClearedListener(() => replacedGatewayKeyFingerprints.clear());
    historyClearListenerInstalled = true;
  }
  replacedGatewayKeyFingerprints.add(keyFingerprint(previousKey));
}

export function isReplacedCindyGatewayKey(key: string): boolean {
  return !isAppSessionBoundaryPending() && replacedGatewayKeyFingerprints.has(keyFingerprint(key));
}

let installedReporter: GatewayKeyRejectionReporter | null = null;

/**
 * model-access/index.ts 初始化时安装进程内单例,只需提供凭据同步;其余依赖用本机默认实现。
 * 传 null 卸载(仅测试复位用)。
 */
export function installCindyGatewayKeyRejectionReporter(
  requestSync: (() => Promise<unknown>) | null,
): void {
  if (!requestSync) {
    installedReporter = null;
    return;
  }
  const log = createLogger('modelAccess');
  installedReporter = createGatewayKeyRejectionReporter({
    canUseCindyGateway: () => getAppCapabilities().canUseCindyGateway
      && !isProviderDisabled(readModelDisableOverrides(), 'xd'),
    isSessionBoundaryPending: isAppSessionBoundaryPending,
    getCredentialSource: () => getModelAccessCredentialsStore().getSource(),
    readCurrentKey: () => getProviderSecretStore().get('xd'),
    requestSync,
    log: {
      info: (msg) => log.info(msg),
      warn: (msg) => log.warn(msg),
    },
  });
}

/**
 * 上报一次 Cindy 网关 401。只在三条同时成立时调用:请求发往 Cindy 网关、带的是
 * Cindy AI Key、响应 401。`usedKey` 传本次请求实际携带的 Key。model-access 尚未
 * 初始化时(无凭据同步可触发)直接忽略。
 */
export function reportCindyGatewayKeyRejected(usedKey: string | null | undefined): void {
  installedReporter?.reportUsedKey(usedKey);
}

/**
 * 不知道请求实际用哪把 Key 时的上报(智能体回合因 Key 失效终止)。按本机当前 Key 判断,
 * 当前 Key 在窗口内已被任一入口触发过则跳过;触发同步但不占用准确上报的触发机会。
 */
export function reportCindyGatewayKeyRejectedForCurrentKey(): void {
  installedReporter?.reportCurrentKey();
}

/**
 * 给注入式 fetch 包一层:响应 401 时,用本次请求 Authorization 头里的 Bearer key 上报。
 * 只观察状态码,不读响应体、不改请求和响应;key 是否为 Cindy AI Key 由上报器按规则 A 判定。
 */
export function withCindyGatewayKeyRejectionReport(
  fetchImpl: typeof fetch,
  report: (usedKey: string | null) => void = reportCindyGatewayKeyRejected,
): typeof fetch {
  const wrapped = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const response = await fetchImpl(input, init);
    if (response.status === 401) {
      const usedKey =
        bearerKeyFromHeaders(init?.headers)
        ?? (typeof Request !== 'undefined' && input instanceof Request
          ? bearerKeyFromHeaders(input.headers)
          : null);
      report(usedKey);
    }
    return response;
  };
  return wrapped as typeof fetch;
}