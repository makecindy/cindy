/**
 * chatEmbeddingStore — 聊天嵌入开关的 renderer 端镜像。
 *
 * **真正的 source of truth 是 main 的 <userData>/chat-embedding-settings.json**
 * (apps/desktop/src/main/maker-host/chat-embedding-settings-store.ts), 这里
 * localStorage 只是 renderer UI 即时态镜像 (同 compatModeStore 形态)。
 *
 * 同步路径:
 *   - 启动: bootstrapChatEmbeddingFromMain() 调 IPC 拉 main 真值, 写 localStorage
 *   - toggle: ChatEmbeddingCell 调 IPC, 然后调 setChatEmbeddingEnabled() 更新本地镜像
 *   - provider 变化: useChatEmbedding 重新拉 main 有效值,避免运行时可用性切换留下旧镜像
 *   - main 是 source of truth, renderer 不会从其它路径篡改
 *
 * 二态:
 *   - true  : 新消息会被 enqueue 到 embedding_jobs, Worker 异步嵌入到 chat_messages_vec_v1
 *   - false : createMessage hook 在 enabled 守卫处直接 return, 零成本
 *
 * **偏好默认 true** —— 与 main DEFAULTS 对齐。本镜像只用于设置 UI 即时态; 真正的
 * enqueue 守卫在 main (chat-history-embedder)。bootstrap 在 renderer 启动早期从 main
 * 拉取有效值；请求完成后，不可用或显式关过的状态会同步成 false。
 */

import { extractIpcError } from '@/utils/ipcError';

const STORAGE_KEY = 'chatEmbedding.enabled';

type Subscriber = (value: boolean) => void;
const subscribers = new Set<Subscriber>();

/** Stable chat-embedding IPC errors to localized settings copy. */
export function chatEmbeddingFailureKey(error: unknown): string {
  return extractIpcError(error)?.code === 'UNSUPPORTED_CAPABILITY'
    ? 'settings.chatEmbedding.toast.unavailable'
    : 'settings.chatEmbedding.toast.toggleFailed';
}

/**
 * 同步读 — 默认开 (与 main DEFAULTS 对齐): 仅当显式存过 'false' 才关; 没存过 (null)
 * 或 localStorage 不可用 → true。bootstrap 会用 main 真值覆盖 (显式关过的用户同步成 false)。
 */
export function getChatEmbeddingEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== 'false';
  } catch {
    return true;
  }
}

/** 同步写 — 落 localStorage + 通知 subscriber */
export function setChatEmbeddingEnabled(next: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, next ? 'true' : 'false');
  } catch {
    // localStorage 不可用 — 忽略
  }
  subscribers.forEach((cb) => cb(next));
}

/** 订阅变化 — hook 用, 也可以给非 React 路径用。返回 unsubscribe。 */
export function subscribeChatEmbeddingEnabled(cb: Subscriber): () => void {
  subscribers.add(cb);

  const storageHandler = (e: StorageEvent) => {
    if (e.key !== STORAGE_KEY) return;
    cb(getChatEmbeddingEnabled());
  };
  window.addEventListener('storage', storageHandler);

  return () => {
    subscribers.delete(cb);
    window.removeEventListener('storage', storageHandler);
  };
}

/**
 * 启动期一次性从 main 拉真值同步到 localStorage。
 * app entry (index.tsx) 在启动早期触发异步读取；完成后更新 localStorage 和 subscriber。
 *
 * 失败兜底: IPC 错误 (preload 未就绪 / main 异常) 静默 — 留旧值, 用户 toggle
 * 时仍能通过 IPC 写 main, 下次启动恢复正常。
 */
export async function bootstrapChatEmbeddingFromMain(): Promise<void> {
  try {
    const settings = await window.electronAPI.maker.chatEmbeddingGet();
    if (getChatEmbeddingEnabled() === settings.enabled) return;
    setChatEmbeddingEnabled(settings.enabled);
  } catch {
    // preload 未就绪 / IPC 异常 — 留旧 localStorage
  }
}
