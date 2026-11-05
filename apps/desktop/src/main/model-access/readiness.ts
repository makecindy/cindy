import { getAppCapabilities } from '../appCapabilities.js';
import { getProviderSecretStore } from '../secrets/providerSecretStore.js';
import type { ModelAccessStatus } from '../../shared/modelAccess.js';

let credentialsProvisioning = false;

/**
 * Lightweight Host capability probe for consumers that must not initialize
 * the model-access IPC / gateway runtime merely to assess readiness.
 *
 * The owning subsystem remains authoritative: Cindy account capability and
 * the locally persisted gateway credential must both be present.
 */
export function isModelAccessReady(): boolean {
  return getAppCapabilities().canUseCindyGateway && Boolean(getProviderSecretStore().get('xd'));
}

/**
 * 网关凭证正在下发(credentialsSync 处于 syncing,含 2s/8s 重试等待)。
 * 首次登录时 key 还没写入,isModelAccessReady() 为 false,但这是马上会好的
 * 临时状态,调用方不能把它当成"未登录"。状态由 model-access 的
 * onStatusChange 同步过来,这里不初始化 model-access 运行时。
 */
export function isModelAccessProvisioning(): boolean {
  return credentialsProvisioning;
}

/** 只由 model-access 的 credentialsSync onStatusChange 调用。 */
export function noteModelAccessSyncState(state: ModelAccessStatus['state']): void {
  credentialsProvisioning = state === 'syncing';
}
