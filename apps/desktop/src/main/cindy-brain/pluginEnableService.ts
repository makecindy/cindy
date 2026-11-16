import { ghostInstallApprovalToken, type InstalledGhost } from '../../shared/ghost.js';
import { installedGhostPhysicalRelId, installedGhostStoragePart } from '../../shared/pluginIdentity.js';

export interface PluginEnableServicePorts {
  find(id: string): InstalledGhost | null | undefined;
  requireAvailable(id: string): void;
  notFound(message: string): never;
  acquire(id: string): () => void;
  stop(id: string): Promise<void>;
  persist(relId: string, enabled: boolean, approval: string, assertCurrent?: () => void): Promise<void>;
  start(id: string): void;
  didChange(id: string, enabled: boolean): Promise<void>;
}

/** Shared user enable/disable transaction. Revoke execution before changing the
 * receipt; change the visible unread projection only after persistence succeeds.
 * Platform adapters own processes and UI, never installation identity or order. */
export async function setPluginEnabled(
  ports: PluginEnableServicePorts, id: string, enabled: boolean,
  expectedApproval?: string, assertCurrent?: () => void,
): Promise<{ ok: true }> {
  assertCurrent?.();
  const target = ports.find(id);
  if (!target) return ports.notFound('目标插件实例已不存在');
  const approval = ghostInstallApprovalToken(target.approval);
  if (expectedApproval !== undefined && expectedApproval !== approval)
    return ports.notFound('目标插件安装已变更');
  ports.requireAvailable(id);
  const storagePart = installedGhostStoragePart(target);
  const release = ports.acquire(storagePart);
  try {
    if (!enabled) await ports.stop(storagePart);
    assertCurrent?.();
    await ports.persist(installedGhostPhysicalRelId(target), enabled, expectedApproval ?? approval, assertCurrent);
    // The receipt is committed. Complete its effects even if the caller disconnected.
    if (enabled) ports.start(storagePart);
    await ports.didChange(id, enabled);
    return { ok: true };
  } finally {
    release();
  }
}
