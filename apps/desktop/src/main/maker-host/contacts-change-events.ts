/** Main 内部的通讯录本地变更事件；不携带联系人内容。 */

const listeners = new Set<() => void>();

export function onLocalContactsChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function emitLocalContactsChanged(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // 后台同步监听失败不能把已成功的通讯录写入伪装成 IPC 失败。
    }
  }
}
