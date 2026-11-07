import { getAppCapabilities } from '../appCapabilities.js';
import { getProviderSecretStore } from '../secrets/providerSecretStore.js';
import type { ModelAccessStatus } from '../../shared/modelAccess.js';

let credentialsTransientlyUnavailable = false;

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
 * 网关凭证暂时取不到,但同一账号下会恢复:credentialsSync 处于 syncing(含 2s/8s
 * 重试等待),或 failed(重试预算用完 / 落盘失败;本地既有 key 保留,设置页重试或
 * 下一次同步可恢复)。首次登录时 key 还没写入,isModelAccessReady() 为 false,
 * 调用方不能把这段时间当成"未登录"。状态由 model-access 的 onStatusChange
 * 同步过来,这里不初始化 model-access 运行时。
 */
export function isModelAccessTransientlyUnavailable(): boolean {
  return credentialsTransientlyUnavailable;
}

/** 只由 model-access 的 credentialsSync onStatusChange 调用。 */
export function noteModelAccessSyncState(state: ModelAccessStatus['state']): void {
  credentialsTransientlyUnavailable = state === 'syncing' || state === 'failed';
}
