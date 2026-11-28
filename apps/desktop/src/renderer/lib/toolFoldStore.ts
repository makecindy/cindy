/**
 * toolFoldStore — 「工具载荷折叠」实验开关的 renderer 端镜像。
 *
 * Source of truth: main 的 <userData>/tool-fold-settings.json (tool-fold-store.ts)。
 * 这里 localStorage 只是 renderer UI 即时态镜像, 完全照搬 lspModeStore 形态。
 *
 * 二态:
 *   - true  : 之后启动的 Pi 任务加载内置 cindy-tool-fold 扩展(折叠老工具往返)
 *   - false : 不加载, 行为与没有该扩展时完全一致(默认值)
 *
 * **默认 false** —— 实验性功能: 折叠会改写送给模型的上下文, 真实长会话上的模型
 * 行为还没验证过, 必须由用户在设置里显式 opt-in。
 */

const STORAGE_KEY = 'toolFold.enabled';

type Subscriber = (value: boolean) => void;
const subscribers = new Set<Subscriber>();

export function getToolFoldEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function setToolFoldEnabled(next: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, next ? 'true' : 'false');
  } catch {
    // localStorage 不可用 — 忽略
  }
  subscribers.forEach((cb) => cb(next));
}

export function subscribeToolFoldEnabled(cb: Subscriber): () => void {
  subscribers.add(cb);
  const storageHandler = (e: StorageEvent) => {
    if (e.key !== STORAGE_KEY) return;
    cb(getToolFoldEnabled());
  };
  window.addEventListener('storage', storageHandler);
  return () => {
    subscribers.delete(cb);
    window.removeEventListener('storage', storageHandler);
  };
}

/**
 * 启动期一次性从 main 拉真值同步到 localStorage。
 * 失败兜底: 静默, 留旧值。
 */
export async function bootstrapToolFoldFromMain(): Promise<void> {
  try {
    const settings = await window.electronAPI.maker.toolFoldGet();
    if (getToolFoldEnabled() === settings.enabled) return;
    setToolFoldEnabled(settings.enabled);
  } catch {
    // preload 未就绪 / IPC 异常 — 留旧 localStorage
  }
}
