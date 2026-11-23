import { useSyncExternalStore } from 'react';

/**
 * 协议更新确认(含判定中的透明遮挡)是否正在挡住本窗口。
 *
 * 其他会自动弹出的模态(更新说明、启动恢复提示等)在此期间要暂缓:后打开的 Radix 弹窗会接管
 * 焦点与外部点击,却画在协议遮罩下面,用户看得到「同意」却点不了。由 LegalTermsUpdateGate 写入。
 */
let blocking = false;
const listeners = new Set<() => void>();

export function setLegalTermsGateBlocking(next: boolean): void {
  if (blocking === next) return;
  blocking = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useLegalTermsGateBlocking(): boolean {
  return useSyncExternalStore(subscribe, () => blocking, () => false);
}
