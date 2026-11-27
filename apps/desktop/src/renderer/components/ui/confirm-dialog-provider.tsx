import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

import { useTranslation } from 'react-i18next';

import {
  ConfirmDialog,
  type ConfirmDialogCheckboxItem,
  type ConfirmDialogProps,
} from '@/components/ui/confirm-dialog';
import { BlockingPromptActiveContext } from '@/components/ui/blocking-prompt-hold';
import { Z_INDEX_LAYERS } from '@/styles/generated/token-mappings';

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
  /** 主按钮变体;destructive 走语义 destructive token(见 ConfirmDialogProps)。 */
  confirmVariant?: 'default' | 'destructive';
  /** 主按钮文字前的小图标(见 ConfirmDialogProps.confirmIcon)。 */
  confirmIcon?: ReactNode;
  /** 让屏幕阅读器开场朗读覆盖 content 清单(见 ConfirmDialogProps.describeContent)。 */
  describeContent?: boolean;
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
  /** 逐字输入 expected 才可确认；由 ConfirmDialog 持有本轮输入状态。 */
  requireTypedConfirmation?: {
    expected: string;
    label: ReactNode;
    placeholder?: string;
  };
  /** 允许确认正文与富内容被框选复制。 */
  contentSelectable?: boolean;
  /**
   * 全局阻断提示:画在 `modal-blocking` 层(高于所有弹窗、菜单与浮层,仅低于 Toast),
   * 并走独立槽位立即显示,不排在普通确认后面。只给「不处理就无法继续使用应用」的
   * 提示(如登录过期);普通确认与授权请求不得使用(DESIGN.md §6 层级刻度)。
   */
  blocking?: boolean;
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
  checkedOverrides?: ConfirmDialogProps['checkedOverrides'];
}

/** 带多个独立业务复选框的 confirm：返回确认状态与本次勾选的 id 列表。 */
export interface ConfirmWithCheckboxesOptions
  extends Omit<ConfirmOptions, 'dontShowAgainKey' | 'dontShowAgainLabel'> {
  checkboxes: readonly ConfirmDialogCheckboxItem[];
  resolveCheckedOverrides?: ConfirmDialogProps['resolveCheckedOverrides'];
}

interface ConfirmDialogContextValue {
  confirm: (options: ConfirmOptions, signal?: AbortSignal) => Promise<boolean>;
  /** 三状态 confirm — 用于「保存 / 不保存 / 取消」这类需要区分 cancel 与 negative 的场景。 */
  confirmThree: (options: ConfirmThreeOptions) => Promise<ConfirmThreeResult>;
  /** 带业务复选框(初始勾选态由 checkboxDefaultChecked 决定,缺省不勾;取消时 checked 恒为 false)。 */
  confirmWithCheckbox: (options: ConfirmWithCheckboxOptions) => Promise<{ ok: boolean; checked: boolean }>;
  /** 带多个独立业务复选框（取消时 checkedIds 恒为空数组）。 */
  confirmWithCheckboxes: (
    options: ConfirmWithCheckboxesOptions,
  ) => Promise<{ ok: boolean; checkedIds: string[] }>;
}

interface QueueItem {
  options: ConfirmOptions & {
    tertiaryText?: string;
    checkboxLabel?: string;
    checkboxDefaultChecked?: boolean;
    checkedOverrides?: ConfirmDialogProps['checkedOverrides'];
    checkboxes?: readonly ConfirmDialogCheckboxItem[];
    resolveCheckedOverrides?: ConfirmDialogProps['resolveCheckedOverrides'];
  };
  resolve: (value: ConfirmThreeResult, dontShowAgain?: boolean, checkedIds?: string[]) => void;
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

interface ConfirmSlot {
  currentItem: QueueItem | null;
  open: boolean;
  enqueue: (item: QueueItem) => void;
  /** AbortSignal 触发:排队中的直接移出,正在显示且未作答的按取消关闭。 */
  abort: (item: QueueItem) => void;
  handleConfirm: (opts?: { dontShowAgain?: boolean; checkedIds?: string[] }) => void;
  handleTertiary: () => void;
  handleOpenChange: (value: boolean) => void;
  /** 当前项显示前的焦点元素;阻断提示关闭后把焦点还给它(见 renderSlot)。 */
  returnFocusTarget: () => HTMLElement | null;
  /** 有项在显示(含退场动画)或排队。 */
  isActive: () => boolean;
  /** 暂停结束后显示下一项(当前没有项在显示时)。 */
  resume: () => void;
}

interface ConfirmSlotHooks {
  /** 返回 true 时不显示下一项:新项只入队,当前项关闭后也不自动推进。 */
  isPaused?: () => boolean;
  /** 当前项关闭且队列已空时调用。 */
  onIdle?: () => void;
}

/**
 * 一个确认框槽位:自己的队列、当前项与开关状态,同一时刻只显示一个,依次处理。
 * 普通确认与阻断提示各用一个槽位,互不排队(见 ConfirmOptions.blocking)。
 */
function useConfirmSlot(hooks: ConfirmSlotHooks = {}): ConfirmSlot {
  const hooksRef = useRef(hooks);
  hooksRef.current = hooks;
  const queueRef = useRef<QueueItem[]>([]);
  const currentItemRef = useRef<QueueItem | null>(null);
  const [currentItem, setCurrentItem] = useState<QueueItem | null>(null);
  const [open, setOpen] = useState(false);
  const isShowingRef = useRef(false);
  const resolvedRef = useRef(false);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const processNext = useCallback(() => {
    if (hooksRef.current.isPaused?.()) return;
    const next = queueRef.current.shift();
    if (next) {
      returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      currentItemRef.current = next;
      setCurrentItem(next);
      setOpen(true);
      isShowingRef.current = true;
      resolvedRef.current = false;
    }
  }, []);

  const enqueue = useCallback(
    (item: QueueItem) => {
      queueRef.current.push(item);
      if (!isShowingRef.current) {
        processNext();
      }
    },
    [processNext],
  );

  const abort = useCallback((item: QueueItem) => {
    const queuedIndex = queueRef.current.indexOf(item);
    if (queuedIndex >= 0) {
      queueRef.current.splice(queuedIndex, 1);
      item.resolve('cancel');
      return;
    }
    if (currentItemRef.current === item && !resolvedRef.current) {
      resolvedRef.current = true;
      item.resolve('cancel');
      setOpen(false);
    }
  }, []);

  const handleConfirm = useCallback(
    (opts?: { dontShowAgain?: boolean; checkedIds?: string[] }) => {
      if (!resolvedRef.current) {
        resolvedRef.current = true;
        currentItem?.resolve('confirm', opts?.dontShowAgain, opts?.checkedIds);
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
        currentItemRef.current = null;
        setCurrentItem(null);
        processNext();
        if (!isShowingRef.current) hooksRef.current.onIdle?.();
      }, 200);
      return () => clearTimeout(timer);
    }
  }, [open, currentItem, processNext]);

  const returnFocusTarget = useCallback(() => returnFocusRef.current, []);
  const isActive = useCallback(() => isShowingRef.current || queueRef.current.length > 0, []);
  const resume = useCallback(() => {
    if (!isShowingRef.current) processNext();
  }, [processNext]);

  return {
    currentItem, open, enqueue, abort, handleConfirm, handleTertiary, handleOpenChange,
    returnFocusTarget, isActive, resume,
  };
}

export function ConfirmDialogProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  // 模块初始化时跑一次性清理,放进 useRef 兜底防止 React StrictMode 双跑(虽然
  // 内部 sentinel 已经够防,这里 ref 只是让闭包语义更清晰)。
  const cleanupOnceRef = useRef(false);
  if (!cleanupOnceRef.current) {
    cleanupOnceRef.current = true;
    clearStaleSkipsOnce();
  }
  // 阻断提示有项(显示中、退场中或排队)时普通槽位暂停:Radix 按挂载顺序管理焦点与 Esc,
  // 不看 zIndex,阻断提示之后才挂载的普通确认虽在遮罩下面,却会抢走焦点、吃掉 Esc。
  // 阻断提示打开前已在显示的普通确认先挂载,不受影响。两个槽位互相引用,经 ref 读取。
  const blockingSlotRef = useRef<ConfirmSlot | null>(null);
  const regularSlotRef = useRef<ConfirmSlot | null>(null);
  const regular = useConfirmSlot({ isPaused: () => blockingSlotRef.current?.isActive() ?? false });
  // 阻断提示独占一个槽位:不排在普通确认后面(普通确认可能正被 modal-raised 面板
  // 压着、用户看不见也关不掉),并画在 modal-blocking 层,盖过所有弹窗与浮层。
  const blocking = useConfirmSlot({ onIdle: () => regularSlotRef.current?.resume() });
  regularSlotRef.current = regular;
  blockingSlotRef.current = blocking;
  const { enqueue: enqueueRegular, abort: abortRegular } = regular;
  const { enqueue: enqueueBlocking, abort: abortBlocking } = blocking;

  const enqueue = useCallback(
    (item: QueueItem) => (item.options.blocking ? enqueueBlocking : enqueueRegular)(item),
    [enqueueBlocking, enqueueRegular],
  );

  const confirm = useCallback(
    (options: ConfirmOptions, signal?: AbortSignal): Promise<boolean> => {
      if (signal?.aborted) return Promise.resolve(false);
      // 用户曾勾过"下次不再提示" → 直接当成 confirm,不弹窗、不入队。
      if (options.dontShowAgainKey && isSkipped(options.dontShowAgainKey)) {
        return Promise.resolve(true);
      }
      return new Promise<boolean>((resolve) => {
        let settled = false;
        // 二状态调用复用同一队列:把 'confirm'→true,其它→false 透传给原 boolean 契约。
        // 用户勾上"下次不再提示"且点 confirm 时,把 key 写入 localStorage。
        const item: QueueItem = {
          options,
          resolve: (r, dontShowAgain) => {
            if (settled) return;
            settled = true;
            signal?.removeEventListener('abort', abort);
            if (r === 'confirm' && dontShowAgain && options.dontShowAgainKey) {
              markSkipped(options.dontShowAgainKey);
            }
            resolve(r === 'confirm');
          },
        };
        const abort = () => (options.blocking ? abortBlocking : abortRegular)(item);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) {
          item.resolve('cancel');
          return;
        }
        enqueue(item);
      });
    },
    [abortBlocking, abortRegular, enqueue],
  );

  const confirmThree = useCallback(
    (options: ConfirmThreeOptions): Promise<ConfirmThreeResult> => {
      return new Promise<ConfirmThreeResult>((resolve) => {
        enqueue({ options, resolve });
      });
    },
    [enqueue],
  );

  const confirmWithCheckbox = useCallback(
    (options: ConfirmWithCheckboxOptions): Promise<{ ok: boolean; checked: boolean }> => {
      return new Promise((resolve) => {
        enqueue({
          options,
          // ConfirmDialog 的复选框状态经 onConfirm({dontShowAgain}) 回传,
          // 这里只是换个语义消费;取消路径拿不到勾选态,按未勾处理。
          resolve: (r, checked) => resolve({ ok: r === 'confirm', checked: Boolean(checked) }),
        });
      });
    },
    [enqueue],
  );

  const confirmWithCheckboxes = useCallback(
    (options: ConfirmWithCheckboxesOptions): Promise<{ ok: boolean; checkedIds: string[] }> => {
      return new Promise((resolve) => {
        enqueue({
          options,
          resolve: (r, _dontShowAgain, checkedIds) =>
            resolve({ ok: r === 'confirm', checkedIds: r === 'confirm' ? (checkedIds ?? []) : [] }),
        });
      });
    },
    [enqueue],
  );

  const renderSlot = (slot: ConfirmSlot, zIndex: number, restoreFocus: boolean) => {
    const { currentItem } = slot;
    if (!currentItem) return null;
    return (
      <ConfirmDialog
        open={slot.open}
        onOpenChange={slot.handleOpenChange}
        zIndex={zIndex}
        // 全局确认没有 Radix trigger,关闭后焦点默认落到 body。阻断提示是插进来的,
        // 关闭后要把焦点还给它打断的那个弹窗(或普通确认),键盘用户才能接着操作。
        restoreFocusTarget={restoreFocus ? slot.returnFocusTarget : undefined}
        title={currentItem.options.title}
        description={currentItem.options.description}
        textClassName={currentItem.options.textClassName}
        content={currentItem.options.content}
        maxWidth={currentItem.options.maxWidth}
        confirmText={currentItem.options.confirmText}
        cancelText={currentItem.options.cancelText}
        // confirmVariant 此前没有透传:GhostConfirmDialogHost 的 danger 分支
        // 一直被静默丢掉(spread 绕过了多余属性检查),这里补上。
        confirmVariant={currentItem.options.confirmVariant}
        confirmIcon={currentItem.options.confirmIcon}
        describeContent={currentItem.options.describeContent}
        showCancel={currentItem.options.showCancel}
        tertiaryText={currentItem.options.tertiaryText}
        // Radix AlertDialog 开场只聚焦 Cancel;阻断提示没有 Cancel 时焦点会留在下面的
        // 弹窗里,这里改为聚焦主按钮,保证键盘与读屏用户落在阻断提示上。
        autoFocusConfirm={
          currentItem.options.autoFocusConfirm ??
          (currentItem.options.blocking && currentItem.options.showCancel === false)
        }
        requireTypedConfirmation={currentItem.options.requireTypedConfirmation}
        contentSelectable={currentItem.options.contentSelectable}
        dontShowAgainLabel={
          currentItem.options.dontShowAgainKey
            ? currentItem.options.dontShowAgainLabel ?? t('commonUi.confirmDialog.dontShowAgain')
            : currentItem.options.checkboxLabel
        }
        checkboxDefaultChecked={currentItem.options.checkboxDefaultChecked}
        checkedOverrides={currentItem.options.checkedOverrides}
        checkboxes={currentItem.options.checkboxes}
        resolveCheckedOverrides={currentItem.options.resolveCheckedOverrides}
        onConfirm={slot.handleConfirm}
        onTertiary={slot.handleTertiary}
      />
    );
  };

  return (
    <ConfirmDialogContext.Provider value={{ confirm, confirmThree, confirmWithCheckbox, confirmWithCheckboxes }}>
      {/* 阻断提示显示或退场中时,界面里独立挂载的 ConfirmDialog 暂缓新打开(见 useHeldWhileBlockingPrompt)。
          阻断槽位不会只排队不显示,currentItem 即可代表它是否有项。下面两个槽位不在此范围内。 */}
      <BlockingPromptActiveContext.Provider value={blocking.currentItem !== null}>
        {children}
      </BlockingPromptActiveContext.Provider>
      {renderSlot(regular, Z_INDEX_LAYERS.modal, false)}
      {renderSlot(blocking, Z_INDEX_LAYERS['modal-blocking'], true)}
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

/**
 * 可选读取全局确认框。仅供既能独立渲染、又能挂在完整应用壳内的复用组件使用：
 * 正式窗口都由 ConfirmDialogProvider 提供共享弹窗；Story / 单测等裸渲染环境返回 null，
 * 避免为了展示一个纯列表就强制复制整套应用 Provider。
 */
export function useOptionalConfirmDialog(): ConfirmDialogContextValue | null {
  return useContext(ConfirmDialogContext);
}
