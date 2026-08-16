/**
 * 通用 Toast 全局命令式 API + 模块级单例 Store。
 *
 * 设计要点：
 * - 无 Provider。任意代码（包括非 React 的 fetch 拦截器）都可调用 toast.xxx()
 * - 模块级单例 Store，用 useSyncExternalStore 订阅
 * - 最大并发 3 条，超出部分 FIFO 进入等待队列
 * - 默认 duration 按 variant 区分：info / success 1200ms，warning / error 8000ms
 *   （警告和错误都需要用户读完，太短根本来不及看清）；0 表示永久显示
 * - hover 悬停时暂停自动关闭（pauseAutoDismiss / resumeAutoDismiss），移开后按剩余时长继续
 * - 退出动画完成后（200ms）才真正从 state 移除
 *
 * 不要把视觉组件混在这里 —— Toast.tsx / ToastContainer.tsx 另外放。
 */

export type ToastVariant = 'info' | 'success' | 'warning' | 'error';

/**
 * 提示来源(第三方供文案时的身份头,由宿主画在正文前;当前消费方:意识
 * notify 槽)。存在即渲染「图标+名字」前缀——内容是谁说的必须一眼可辨,
 * 第三方伪装不了主机自己的提示。
 */
export interface ToastSource {
  name: string;
  /** 来源图标(data URL);缺省只显示名字。 */
  iconDataUrl?: string;
}

export interface ToastOptions {
  /** 自动关闭时长（ms）。不传时按 variant 取默认：info / success 1200，warning / error 8000；0 表示永久显示 */
  duration?: number;
  /** 来源身份头（见 ToastSource；主机自己的提示不传） */
  source?: ToastSource;
  /** 关闭时回调 */
  onClose?: () => void;
}

export interface ToastItem {
  id: string;
  variant: ToastVariant;
  message: string;
  duration: number;
  source?: ToastSource;
  onClose?: () => void;
  createdAt: number;
  /** 是否处于退出动画阶段（仍在 state 里但即将被移除） */
  exiting: boolean;
}

// ============================================================
// 常量
// ============================================================

const DEFAULT_DURATION = 1200;
// warning / error 都需要用户读完（warning 常带操作指引，error 常带诊断），默认停留显著拉长
const DEFAULT_ALERT_DURATION = 8000;
const MAX_ACTIVE = 3;
const EXIT_ANIMATION_MS = 300;

// ============================================================
// 内部状态（闭包内私有）
// ============================================================

let activeItems: ToastItem[] = [];
const queue: ToastItem[] = [];
const listeners = new Set<() => void>();

// 每条 Toast 的定时器句柄
const timers = new Map<string, ReturnType<typeof setTimeout>>();

// 每条 Toast 自动关闭的绝对到期时间戳（暂停时用来折算剩余时长）
const expireAtMs = new Map<string, number>();

// hover 暂停期间保存的剩余时长（存在即视为"暂停中"）
const pausedRemainingMs = new Map<string, number>();

// ============================================================
// 订阅机制（供 useSyncExternalStore 使用）
// ============================================================

function notify() {
  listeners.forEach((l) => l());
}

export function subscribeToastStore(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getToastSnapshot(): ToastItem[] {
  return activeItems;
}

// ============================================================
// ID 生成
// ============================================================

let idCounter = 0;
function generateId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  idCounter += 1;
  return `toast-${Date.now()}-${idCounter}`;
}

// ============================================================
// 定时器管理
// ============================================================

function startTimer(id: string, duration: number) {
  // duration=0 永久显示，不启动定时器
  if (duration <= 0) return;
  expireAtMs.set(id, Date.now() + duration);
  const handle = setTimeout(() => {
    beginExit(id);
  }, duration);
  timers.set(id, handle);
}

function clearItemTimer(id: string) {
  const handle = timers.get(id);
  if (handle) clearTimeout(handle);
  timers.delete(id);
  expireAtMs.delete(id);
  pausedRemainingMs.delete(id);
}

// 鼠标移开后至少再停留这么久，避免"恢复即到期"的突兀消失
const MIN_RESUME_REMAINING_MS = 1000;

/**
 * hover 暂停自动关闭：清掉定时器并记住剩余时长。
 * 永久显示（duration=0）、已在退出动画、或已暂停的条目均为 no-op。
 */
function pauseItemTimer(id: string) {
  const handle = timers.get(id);
  if (!handle) return;
  clearTimeout(handle);
  timers.delete(id);
  const expireAt = expireAtMs.get(id);
  if (expireAt === undefined) return;
  expireAtMs.delete(id);
  pausedRemainingMs.set(id, Math.max(expireAt - Date.now(), MIN_RESUME_REMAINING_MS));
}

/** hover 结束恢复自动关闭：按暂停时记下的剩余时长重新计时。 */
function resumeItemTimer(id: string) {
  const remaining = pausedRemainingMs.get(id);
  if (remaining === undefined) return;
  pausedRemainingMs.delete(id);
  startTimer(id, remaining);
}

// ============================================================
// 入队 & 补位
// ============================================================

function admitFromQueue() {
  while (activeItems.length < MAX_ACTIVE && queue.length > 0) {
    const next = queue.shift()!;
    activeItems = [next, ...activeItems];
    startTimer(next.id, next.duration);
  }
}

function addItem(item: ToastItem) {
  if (activeItems.length < MAX_ACTIVE) {
    // 新的永远在顶部
    activeItems = [item, ...activeItems];
    startTimer(item.id, item.duration);
  } else {
    queue.push(item);
  }
  notify();
}

// ============================================================
// 退出流程：先标记 exiting 触发退出动画，200ms 后真正移除
// ============================================================

function beginExit(id: string) {
  const idx = activeItems.findIndex((t) => t.id === id);
  if (idx === -1) {
    // 可能还在 queue 中（比如 dismissAll 时），直接从 queue 清理
    const qIdx = queue.findIndex((t) => t.id === id);
    if (qIdx !== -1) {
      const [removed] = queue.splice(qIdx, 1);
      removed.onClose?.();
      notify();
    }
    return;
  }
  const current = activeItems[idx];
  if (current.exiting) return; // 重复退出保护

  clearItemTimer(id);

  activeItems = [
    ...activeItems.slice(0, idx),
    { ...current, exiting: true },
    ...activeItems.slice(idx + 1),
  ];
  notify();

  setTimeout(() => {
    finalizeRemove(id);
  }, EXIT_ANIMATION_MS);
}

function finalizeRemove(id: string) {
  const idx = activeItems.findIndex((t) => t.id === id);
  if (idx === -1) return;
  const removed = activeItems[idx];
  activeItems = [...activeItems.slice(0, idx), ...activeItems.slice(idx + 1)];
  removed.onClose?.();
  admitFromQueue();
  notify();
}

// ============================================================
// 对外命令式 API
// ============================================================

function createItem(variant: ToastVariant, message: string, options?: ToastOptions): string {
  const id = generateId();
  const item: ToastItem = {
    id,
    variant,
    message,
    duration:
      options?.duration ??
      (variant === 'error' || variant === 'warning' ? DEFAULT_ALERT_DURATION : DEFAULT_DURATION),
    ...(options?.source ? { source: options.source } : {}),
    onClose: options?.onClose,
    createdAt: Date.now(),
    exiting: false,
  };
  addItem(item);
  return id;
}

export const toast = {
  info(message: string, options?: ToastOptions): string {
    return createItem('info', message, options);
  },
  success(message: string, options?: ToastOptions): string {
    return createItem('success', message, options);
  },
  warning(message: string, options?: ToastOptions): string {
    return createItem('warning', message, options);
  },
  error(message: string, options?: ToastOptions): string {
    return createItem('error', message, options);
  },
  /**
   * 改写已显示 toast 的 message, 不重置 duration / 不重发入场动画。找不到 id
   * (已 dismiss 或不存在) 直接 no-op, 不报错 — 调用方常不知道 toast 是否已被
   * 自动关闭, 强行报错没意义。
   *
   * 设计目的: 给长任务 (silent install / progress 之类) 改 toast 副文案,
   * 避免反复 dismiss+success 触发的"toast 闪两下"。
   */
  update(id: string, message: string): void {
    const idx = activeItems.findIndex((t) => t.id === id);
    if (idx === -1) {
      // 也可能还在等待队列里, 也要支持
      const qIdx = queue.findIndex((t) => t.id === id);
      if (qIdx !== -1) queue[qIdx] = { ...queue[qIdx], message };
      return;
    }
    activeItems = [
      ...activeItems.slice(0, idx),
      { ...activeItems[idx], message },
      ...activeItems.slice(idx + 1),
    ];
    notify();
  },
  /** hover 进入时调用：暂停该条 toast 的自动关闭计时（永久显示 / 已退出的条目 no-op）。 */
  pauseAutoDismiss(id: string): void {
    pauseItemTimer(id);
  },
  /** hover 离开时调用：按剩余时长恢复自动关闭计时。 */
  resumeAutoDismiss(id: string): void {
    resumeItemTimer(id);
  },
  dismiss(id: string): void {
    beginExit(id);
  },
  dismissAll(): void {
    // 清空等待队列
    const pending = queue.splice(0, queue.length);
    pending.forEach((p) => p.onClose?.());
    // 触发所有活跃项的退出动画
    const ids = activeItems.map((t) => t.id);
    ids.forEach((id) => beginExit(id));
    notify();
  },
};
