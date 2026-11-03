/**
 * 打开供应商分享链接的意图(深链、粘贴、系统通知)。MainLayout 收到后交给全局的
 * 申请弹窗；弹窗还没挂载时保留最后一条，挂载后立即取走。
 */
type Listener = (link: string) => void;

let pending: string | null = null;
const listeners = new Set<Listener>();

export function requestProviderShareJoin(link: string): void {
  if (listeners.size === 0) {
    pending = link;
    return;
  }
  for (const listener of listeners) listener(link);
}

export function subscribeProviderShareJoin(listener: Listener): () => void {
  listeners.add(listener);
  if (pending) {
    const link = pending;
    pending = null;
    listener(link);
  }
  return () => {
    listeners.delete(listener);
  };
}
