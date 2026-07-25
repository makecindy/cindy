import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

import { ConfirmDialog } from '@/components/ui/confirm-dialog';

export interface ConfirmOptions {
  title: string;
  description?: string;
  /** 可选的标题与正文样式；仅调用方显式传入时生效。 */
  textClassName?: string;
  /** 富内容区(渲染在 description 之后;见 ConfirmDialogProps.content)。 */
  content?: ReactNode;
  /** 弹窗最大宽度(px),缺省 400;见 ConfirmDialogProps.maxWidth。 */
  maxWidth?: number;
  confirmText?: string;
  cancelText?: string;
  showCancel?: boolean;
  /**
   * 设了就在弹窗底部加一个"下次不再提示"复选框,并把勾选状态以 '1' 写入
   * `localStorage[dontShowAgainKey]`。下次同 key 调 confirm() 时直接 resolve(true)
   * 跳过弹窗。仅作用于 confirm() (boolean 契约) ; confirmThree() 不受影响。
   * 如需重置,删除对应 localStorage 键即可。
   */
  dontShowAgainKey?: string;
  /** 复选框文案,默认"下次不再提示"。 */
  dontShowAgainLabel?: string;
  /**
   * 让默认焦点落到主按钮(而非 Radix 默认的 Cancel)。
   * 仅适合"主操作非破坏性"的弹窗,例如"前往设置 / 取消"。
   * 破坏性确认(删除/重置等)请保持默认。
   */
  autoFocusConfirm?: boolean;
}

const DONT_SHOW_AGAIN_PREFIX = 'confirm-dialog.skip:';

function isSkipped(key: string): boolean {
  try {
    return localStorage.getItem(DONT_SHOW_AGAIN_PREFIX + key) === '1';
  } catch {
    return false;
  }
}

function markSkipped(key: string): void {
  try {
    localStorage.setItem(DONT_SHOW_AGAIN_PREFIX + key, '1');
  } catch {
    // localStorage 写失败(隐私模式 / 配额)不致命,下次再问一遍即可。
  }
}

/** 三状态结果:'confirm' = 主按钮 / 'tertiary' = 第三按钮 / 'cancel' = 次按钮、Esc、外部点击。 */
export type ConfirmThreeResult = 'confirm' | 'tertiary' | 'cancel';

export interface ConfirmThreeOptions extends ConfirmOptions {
  /** 第三按钮文案。必填 —— 缺它走不到三状态分支。 */
  tertiaryText: string;
}

/** 带业务复选框的 confirm(如装意识的"立即开启"):返回确认与勾选态。 */
export interface ConfirmWithCheckboxOptions extends Omit<ConfirmOptions, 'dontShowAgainKey' | 'dontShowAgainLabel'> {
  /** 复选框文案。复用 ConfirmDialog 的复选框管线,但不写 localStorage(纯本次语义)。 */
  checkboxLabel: string;
  /** 复选框初始勾选态,缺省 false;每次弹出都复位到该值。 */
  checkboxDefaultChecked?: boolean;
}

interface ConfirmDialogContextValue {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  /** 三状态 confirm — 用于「保存 / 不保存 / 取消」这类需要区分 cancel 与 negative 的场景。 */
  confirmThree: (options: ConfirmThreeOptions) => Promise<ConfirmThreeResult>;
  /** 带业务复选框(初始勾选态由 checkboxDefaultChecked 决定,缺省不勾;取消时 checked 恒为 false)。 */
  confirmWithCheckbox: (options: ConfirmWithCheckboxOptions) => Promise<{ ok: boolean; checked: boolean }>;
}

interface QueueItem {
  options: ConfirmOptions & {
    tertiaryText?: string;
    checkboxLabel?: string;
    checkboxDefaultChecked?: boolean;
  };
  resolve: (value: ConfirmThreeResult, dontShowAgain?: boolean) => void;
}

const ConfirmDialogContext = createContext<ConfirmDialogContextValue | null>(null);

/**
 * 一次性清掉之前可能被误勾选的 markdown 保存确认 skip 键。Ctrl+S 之前不弹窗、
 * 直接写盘,有用户在弹窗版本里勾了"下次不再提示"以为只关弹窗,结果连按钮路径
 * 也跳了 —— 这里强制重置一次,让用户重新选择。sentinel 键保证只跑一次。
 * 后续不需要再清的话,这一段连同 sentinel 一起删掉即可。
 */
function clearStaleSkipsOnce(): void {
  const SENTINEL = 'confirm-dialog.cleanup.v1';
  try {
    if (localStorage.getItem(SENTINEL) === '1') return;
    localStorage.removeItem(DONT_SHOW_AGAIN_PREFIX + 'doc.markdown.save-confirm');
    localStorage.setItem(SENTINEL, '1');
  } catch {
    // localStorage 不可用 → 跳过,下次启动再试一次也无害。
  }
}

export function ConfirmDialogProvider({ children }: { children: ReactNode }) {
  // 模块初始化时跑一次性清理,放进 useRef 兜底防止 React StrictMode 双跑(虽然
  // 内部 sentinel 已经够防,这里 ref 只是让闭包语义更清晰)。
  const cleanupOnceRef = useRef(false);
  if (!cleanupOnceRef.current) {
    cleanupOnceRef.current = true;
    clearStaleSkipsOnce();
  }
  const queueRef = useRef<QueueItem[]>([]);
  const [currentItem, setCurrentItem] = useState<QueueItem | null>(null);
  const [open, setOpen] = useState(false);
  const isShowingRef = useRef(false);
  const resolvedRef = useRef(false);

  const processNext = useCallback(() => {
    const next = queueRef.current.shift();
    if (next) {
      setCurrentItem(next);
      setOpen(true);
      isShowingRef.current = true;
      resolvedRef.current = false;
    }
  }, []);

  const confirm = useCallback(
    (options: ConfirmOptions): Promise<boolean> => {
      // 用户曾勾过"下次不再提示" → 直接当成 confirm,不弹窗、不入队。
      if (options.dontShowAgainKey && isSkipped(options.dontShowAgainKey)) {
        return Promise.resolve(true);
      }
      return new Promise<boolean>((resolve) => {
        // 二状态调用复用同一队列:把 'confirm'→true,其它→false 透传给原 boolean 契约。
        // 用户勾上"下次不再提示"且点 confirm 时,把 key 写入 localStorage。
        const item: QueueItem = {
          options,
          resolve: (r, dontShowAgain) => {
            if (r === 'confirm' && dontShowAgain && options.dontShowAgainKey) {
              markSkipped(options.dontShowAgainKey);
            }
            resolve(r === 'confirm');
          },
        };
        queueRef.current.push(item);
        if (!isShowingRef.current) {
          processNext();
        }
      });
    },
    [processNext],
  );

  const confirmThree = useCallback(
    (options: ConfirmThreeOptions): Promise<ConfirmThreeResult> => {
      return new Promise<ConfirmThreeResult>((resolve) => {
        const item: QueueItem = { options, resolve };
        queueRef.current.push(item);
        if (!isShowingRef.current) {
          processNext();
        }
      });
    },
    [processNext],
  );

  const confirmWithCheckbox = useCallback(
    (options: ConfirmWithCheckboxOptions): Promise<{ ok: boolean; checked: boolean }> => {
      return new Promise((resolve) => {
        const item: QueueItem = {
          options,
          // ConfirmDialog 的复选框状态经 onConfirm({dontShowAgain}) 回传,
          // 这里只是换个语义消费;取消路径拿不到勾选态,按未勾处理。
          resolve: (r, checked) => resolve({ ok: r === 'confirm', checked: Boolean(checked) }),
        };
        queueRef.current.push(item);
        if (!isShowingRef.current) {
          processNext();
        }
      });
    },
    [processNext],
  );

  const handleConfirm = useCallback(
    (opts?: { dontShowAgain?: boolean }) => {
      if (!resolvedRef.current) {
        resolvedRef.current = true;
        currentItem?.resolve('confirm', opts?.dontShowAgain);
        setOpen(false);
      }
    },
    [currentItem],
  );

  const handleTertiary = useCallback(() => {
    if (!resolvedRef.current) {
      resolvedRef.current = true;
      currentItem?.resolve('tertiary');
      // tertiary 按钮不是 AlertDialog.Action / Cancel,不会自动关 dialog,这里手动触发。
      setOpen(false);
    }
  }, [currentItem]);

  const handleOpenChange = useCallback(
    (value: boolean) => {
      if (!value) {
        // Fallback: if not yet resolved (overlay click / Escape), resolve as cancel
        if (!resolvedRef.current) {
          resolvedRef.current = true;
          currentItem?.resolve('cancel');
        }
        setOpen(false);
      }
    },
    [currentItem],
  );

  useEffect(() => {
    if (!open && currentItem !== null) {
      const timer = setTimeout(() => {
        isShowingRef.current = false;
        setCurrentItem(null);
        processNext();
      }, 200);
      return () => clearTimeout(timer);
    }
  }, [open, currentItem, processNext]);

  return (
    <ConfirmDialogContext.Provider value={{ confirm, confirmThree, confirmWithCheckbox }}>
      {children}
      {currentItem && (
        <ConfirmDialog
          open={open}
          onOpenChange={handleOpenChange}
          title={currentItem.options.title}
          description={currentItem.options.description}
          textClassName={currentItem.options.textClassName}
          content={currentItem.options.content}
          maxWidth={currentItem.options.maxWidth}
          confirmText={currentItem.options.confirmText}
          cancelText={currentItem.options.cancelText}
          showCancel={currentItem.options.showCancel}
          tertiaryText={currentItem.options.tertiaryText}
          autoFocusConfirm={currentItem.options.autoFocusConfirm}
          dontShowAgainLabel={
            currentItem.options.dontShowAgainKey
              ? currentItem.options.dontShowAgainLabel ?? '下次不再提示'
              : currentItem.options.checkboxLabel
          }
          checkboxDefaultChecked={currentItem.options.checkboxDefaultChecked}
          onConfirm={handleConfirm}
          onTertiary={handleTertiary}
        />
      )}
    </ConfirmDialogContext.Provider>
  );
}

export function useConfirmDialog(): ConfirmDialogContextValue {
  const context = useContext(ConfirmDialogContext);
  if (!context) {
    throw new Error('useConfirmDialog must be used within ConfirmDialogProvider');
  }
  return context;
}
