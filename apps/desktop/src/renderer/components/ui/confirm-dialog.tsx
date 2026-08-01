import { useEffect, useRef, useState, type ReactNode } from 'react';
import * as AlertDialog from '@radix-ui/react-alert-dialog';
import { useTranslation } from 'react-i18next';

import { flashScrollbar } from '@/lib/scrollbarAutoHide';
import { cn } from '@/lib/utils';
import { Spinner } from '@/components/ui/spinner';

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  /** 可选的标题与正文样式；富内容区与按钮不受影响。 */
  textClassName?: string;
  /**
   * 富内容区(如装意识的逐项权限清单):渲染在 description 之后、复选框之前。
   * 与 description 独立 —— Radix Description 是 <p>,块级列表不能塞进去。
   *
   * 高度与滚动由本组件统一持有(max-h-[85vh] + 内部滚动区),caller 不必也不该
   * 再给 content 套一层自己的限高滚动容器 —— 两层限高会让"到底了没有"取决于
   * 内外层谁先触底,行为不好解释,滚动条提示也会落在错误的那一层。
   */
  content?: ReactNode;
  /**
   * 弹窗最大宽度(px),缺省 400。带富内容清单的弹窗(如意识装入确认)
   * 用默认宽会折行到累,可适度放宽;普通二选一确认别动它。
   */
  maxWidth?: number;
  confirmText?: string;
  cancelText?: string;
  showCancel?: boolean;
  /** 可选的第三按钮(如「不保存」)。设了即渲染,在 confirm/cancel 之间。
   *  典型场景:文件未保存时关闭 tab → 保存(primary) / 不保存(tertiary) / 取消(secondary)。 */
  tertiaryText?: string;
  /** 设了就在底部加一个"下次不再提示"复选框,onConfirm 携带勾选状态回传。 */
  dontShowAgainLabel?: string;
  /**
   * 复选框初始勾选态,缺省 false。"下次不再提示"类弹窗保持缺省;
   * 业务复选框(confirmWithCheckbox)按调用方语义决定,如装意识的
   * "立即开启"默认勾选。
   */
  checkboxDefaultChecked?: boolean;
  /**
   * Radix AlertDialog 默认会自动聚焦 Cancel 按钮(为破坏性操作做的安全默认)。
   * 在"主按钮非破坏性、Cancel 仅是放弃"的场景(如"前往设置 / 取消"),
   * 把这个开关打开,让默认焦点落到主按钮,避免取消按钮天然带 focus ring。
   */
  autoFocusConfirm?: boolean;
  /** Disable the primary action until caller-owned validation has passed. */
  confirmDisabled?: boolean;
  /** 嵌套在其它 Dialog 内时提升层级；普通确认继续使用默认层级。 */
  zIndex?: number;
  /** Destructive actions use the semantic destructive theme tokens. */
  confirmVariant?: 'default' | 'destructive';
  /**
   * 进入"操作进行中"态:主按钮内容换成 spinner、所有按钮禁用,
   * 同时 ESC 和点击外部都不再关弹框。典型场景:用户点了确认后触发的
   * 不可逆操作(如关闭应用),期间不应再让用户操作 UI。
   * 注意:loading 期间调用方必须自己在 onOpenChange 里拦住 next=false,
   * 否则按钮 disabled 也无法阻止状态被外部改成 closed。
   */
  loading?: boolean;
  onConfirm?: (opts?: { dontShowAgain?: boolean }) => void;
  onCancel?: () => void;
  onTertiary?: () => void;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  textClassName,
  content,
  maxWidth,
  confirmText,
  cancelText,
  showCancel = true,
  tertiaryText,
  dontShowAgainLabel,
  checkboxDefaultChecked = false,
  autoFocusConfirm,
  confirmDisabled = false,
  confirmVariant = 'default',
  loading = false,
  onConfirm,
  onCancel,
  onTertiary,
  zIndex = 10000,
}: ConfirmDialogProps) {
  const { t } = useTranslation();
  const resolvedConfirmText = confirmText ?? t('commonUi.confirmDialog.confirm');
  const resolvedCancelText = cancelText ?? t('commonUi.confirmDialog.cancel');
  // 每次打开复位到初始勾选态,避免上一轮的勾选残留到下一次弹窗。
  const [dontShowAgain, setDontShowAgain] = useState(checkboxDefaultChecked);
  useEffect(() => {
    if (open) setDontShowAgain(checkboxDefaultChecked);
  }, [open, checkboxDefaultChecked]);
  const confirmBtnRef = useRef<HTMLButtonElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // 滚动条 thumb 默认透明(globals.css),不滚不 hover 就看不见"下面还有内容"。
  // 授权确认场景里这不是观感问题:权限清单被折在视口下面而用户不知道,等于
  // 在信息不全的情况下点了同意。所以弹窗一出现就主动闪一下滚动条(不可滚则
  // no-op),内容变高(展开简介/工具组)后再闪一次。
  const revealScrollbar = () => {
    requestAnimationFrame(() => {
      if (scrollRef.current) flashScrollbar(scrollRef.current);
    });
  };
  useEffect(() => {
    if (!open) return;
    // Radix 开场动画期间 layout 还在变,下一帧再量 scrollHeight 才准。
    const raf = requestAnimationFrame(() => {
      if (scrollRef.current) flashScrollbar(scrollRef.current);
    });
    return () => cancelAnimationFrame(raf);
  }, [open]);
  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay
          className={cn(
            'fixed inset-0 z-[10000]',
            'bg-neutral-900/40 dark:bg-neutral-950/60',
            'data-[state=open]:animate-confirm-overlay-in',
            'data-[state=closed]:animate-confirm-overlay-out',
          )}
          style={{ WebkitAppRegion: 'no-drag', zIndex } as React.CSSProperties}
        />
        <AlertDialog.Content
          className={cn(
            'fixed left-1/2 top-1/2 z-[10000] -translate-x-1/2 -translate-y-1/2',
            'flex max-h-[85vh] flex-col',
            'w-full select-none rounded-xl p-4',
            'bg-[var(--confirm-bg)] shadow-[var(--confirm-shadow)]',
            'data-[state=open]:animate-confirm-content-in',
            'data-[state=closed]:animate-confirm-content-out',
          )}
          style={{ WebkitAppRegion: 'no-drag', maxWidth: maxWidth ?? 400, zIndex } as React.CSSProperties}
          {...(!description ? { 'aria-describedby': undefined } : {})}
          onEscapeKeyDown={(e) => {
            if (loading) e.preventDefault();
          }}
          onOpenAutoFocus={
            autoFocusConfirm
              ? (e) => {
                  // Radix 默认聚焦第一个可聚焦元素 / Cancel —— 这里覆盖,
                  // 把焦点交给主按钮,避免"取消"天然带 focus ring。
                  e.preventDefault();
                  confirmBtnRef.current?.focus();
                }
              : undefined
          }
        >
          <AlertDialog.Title
            className={cn('shrink-0 text-lg font-medium text-[var(--confirm-title)]', textClassName)}
          >
            {title}
          </AlertDialog.Title>
          {(description || content) && (
            // 富内容 / 长正文可能超过视口高度:包一层限高滚动区,让标题与底部按钮
            // 固定、中间内容纵向滚动,避免整个弹窗被撑出屏幕后无法滚动到被裁掉的内容
            // (典型:插件更新确认框的权限变更清单)。
            <div
              ref={scrollRef}
              // 内容里的折叠区(如权限清单的工具组)展开后高度会变,capture 阶段
              // 收一次点击、下一帧重新判定是否可滚,让滚动条跟着新高度再闪一下。
              onClickCapture={revealScrollbar}
              className={cn(
                'min-h-0 flex-1 overflow-y-auto overscroll-contain',
                // 保持旧间距:有 description 时紧跟标题 mt-2;仅富内容(无正文)
                // 时沿用原 content 的 mt-3,避免 content-only 弹窗间距变化。
                description ? 'mt-2' : 'mt-3',
              )}
            >
              {description && (
                <AlertDialog.Description
                  className={cn('text-base text-[var(--confirm-desc)]', textClassName)}
                >
                  {description}
                </AlertDialog.Description>
              )}
              {content && <div className={cn(description && 'mt-3')}>{content}</div>}
            </div>
          )}
          {dontShowAgainLabel && (
            <label
              className={cn(
                'mt-4 flex shrink-0 cursor-pointer select-none items-center gap-2 text-13',
                'text-[var(--confirm-desc)]',
              )}
            >
              <input
                type="checkbox"
                checked={dontShowAgain}
                onChange={(e) => setDontShowAgain(e.target.checked)}
                className="size-3.5 cursor-pointer accent-[var(--confirm-btn-primary-bg)]"
              />
              {dontShowAgainLabel}
            </label>
          )}
          <div className="mt-6 flex shrink-0 justify-end gap-2.5">
            <AlertDialog.Action asChild>
              <button
                ref={confirmBtnRef}
                disabled={loading || confirmDisabled}
                onClick={() => onConfirm?.({ dontShowAgain })}
                className={cn(
                  'inline-flex min-w-[96px] items-center justify-center rounded-full px-6 py-2.5 text-13 font-medium',
                  'transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
                  'active:scale-[0.98]',
                  confirmVariant === 'destructive'
                    ? 'bg-[hsl(var(--destructive))] text-[var(--accent-pure-cta-fg)] hover:opacity-90 focus-visible:ring-[var(--focus-ring)]'
                    : 'bg-[var(--confirm-btn-primary-bg)] text-[var(--confirm-btn-primary-text)] hover:bg-[var(--confirm-btn-primary-hover)] focus-visible:ring-[var(--confirm-btn-primary-bg)]',
                  loading &&
                    confirmVariant === 'default' &&
                    'cursor-default opacity-80 active:scale-100 hover:bg-[var(--confirm-btn-primary-bg)]',
                  loading &&
                    confirmVariant === 'destructive' &&
                    'cursor-default opacity-80 active:scale-100 hover:opacity-80',
                  confirmDisabled && 'cursor-not-allowed opacity-50 active:scale-100',
                )}
              >
                {loading ? (
                  <Spinner size={14} />
                ) : (
                  resolvedConfirmText
                )}
              </button>
            </AlertDialog.Action>
            {tertiaryText && (
              // tertiary 走 secondary 同款轮廓样式 —— 视觉上 "中性可选";
              // 不用 AlertDialog.Action / Cancel,自己 onClick 触发,Radix 不会
              // 自动关 dialog,因此外层得在 onTertiary 里手动 onOpenChange(false)。
              <button
                type="button"
                disabled={loading}
                onClick={() => onTertiary?.()}
                className={cn(
                  'inline-flex min-w-[96px] items-center justify-center rounded-full px-6 py-2.5 text-13 font-medium',
                  'transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
                  'active:scale-[0.98]',
                  'border bg-transparent',
                  'border-[var(--confirm-btn-secondary-border)] text-[var(--confirm-btn-secondary-text)]',
                  'hover:bg-[var(--confirm-btn-secondary-hover)]',
                  'focus-visible:ring-[var(--confirm-btn-secondary-border)]',
                  loading && 'cursor-default opacity-50 active:scale-100 hover:bg-transparent',
                )}
              >
                {tertiaryText}
              </button>
            )}
            {showCancel && (
              <AlertDialog.Cancel asChild>
                <button
                  disabled={loading}
                  onClick={() => onCancel?.()}
                  className={cn(
                    'inline-flex min-w-[96px] items-center justify-center rounded-full px-6 py-2.5 text-13 font-medium',
                    'transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
                    'active:scale-[0.98]',
                    'border bg-transparent',
                    'border-[var(--confirm-btn-secondary-border)] text-[var(--confirm-btn-secondary-text)]',
                    'hover:bg-[var(--confirm-btn-secondary-hover)]',
                    'focus-visible:ring-[var(--confirm-btn-secondary-border)]',
                    loading && 'cursor-default opacity-50 active:scale-100 hover:bg-transparent',
                  )}
                >
                  {resolvedCancelText}
                </button>
              </AlertDialog.Cancel>
            )}
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
