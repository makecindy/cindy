/**
 * 供应商分享各弹窗共用的外框。结构照 ConfirmDialog(DESIGN §4 Dialog & Modal)：
 *  - 遮罩 `.modal-scrim`，同时是整窗拖动区；面板 `.modal-panel` 是遮罩的 DOM 后代，用
 *    inset-0 + m-auto 居中(不用 transform)，no-drag 挖洞与视觉位置重合；
 *  - 点遮罩不关闭，只能用弹窗自己的按钮或 Esc；
 *  - 只有没有「取消」按钮的弹窗才可以带右上角 ×(`closeLabel`)。
 */
import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ReactNode, RefObject } from 'react';

import { WINDOW_DRAG_STYLE, WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';
import { Button } from '@/components/ui/button';
import { Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

export function ProviderShareDialog({
  open,
  onOpenChange,
  children,
  maxWidth = 460,
  closeLabel,
  initialFocusRef,
  busy = false,
  role = 'dialog',
  testId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
  maxWidth?: number;
  /** 设了就在右上角显示 ×(带 Tip 与无障碍名称)。有「取消」按钮的弹窗不要设。 */
  closeLabel?: string;
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** 操作进行中：Esc 不关闭。 */
  busy?: boolean;
  role?: 'dialog' | 'alertdialog';
  testId?: string;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next && busy) return; onOpenChange(next); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-scrim fixed inset-0 z-[10000]" style={WINDOW_DRAG_STYLE}>
          <Dialog.Content
            role={role}
            data-testid={testId}
            aria-describedby={undefined}
            className={cn(
              'modal-panel fixed inset-0 z-[10000] m-auto h-fit',
              'flex max-h-[85vh] w-full flex-col overflow-y-auto overscroll-contain p-4',
              'text-[var(--text-primary)]',
            )}
            style={{ ...WINDOW_NO_DRAG_STYLE, maxWidth: `min(${maxWidth}px, calc(100vw - 32px))` }}
            onPointerDownOutside={(event) => event.preventDefault()}
            onInteractOutside={(event) => event.preventDefault()}
            onEscapeKeyDown={(event) => {
              if (busy) event.preventDefault();
            }}
            onOpenAutoFocus={
              initialFocusRef
                ? (event) => {
                    event.preventDefault();
                    initialFocusRef.current?.focus();
                  }
                : undefined
            }
          >
            {closeLabel && (
              <Tip text={closeLabel} contentClassName="z-[10001]">
                <Button
                  variant="secondary"
                  size="md"
                  aria-label={closeLabel}
                  disabled={busy}
                  className="absolute right-3 top-3 w-8 border-transparent bg-transparent px-0 text-[var(--confirm-desc)]"
                  onClick={() => onOpenChange(false)}
                >
                  <X size={16} aria-hidden />
                </Button>
              </Tip>
            )}
            {children}
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function ProviderShareDialogTitle({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <Dialog.Title className={cn('text-18 font-medium leading-[1.35] text-[var(--confirm-title)]', className)}>
      {children}
    </Dialog.Title>
  );
}

/** 弹窗底部按钮行：右对齐、可换行；主操作在前，取消在后(DESIGN §4)。 */
export function ProviderShareDialogFooter({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('mt-6 flex shrink-0 flex-wrap justify-end gap-2.5', className)}>{children}</div>;
}

/** 弹窗里的配对码块：大号 4 位数字，读屏按单个数字朗读。 */
export function ProviderSharePairingCode({ code, label, ariaLabel }: { code: string; label: string; ariaLabel: string }) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className="inline-flex shrink-0 items-baseline gap-2.5 rounded-xl border border-[var(--border-default)] bg-[var(--surface)] px-4 py-2"
    >
      <span aria-hidden="true" className="text-12 text-[var(--text-secondary)]">{label}</span>
      <span
        aria-hidden="true"
        data-testid="provider-share-pairing-code"
        className="select-text text-24 font-medium leading-[1.2] tracking-[0.25em] text-[var(--text-primary)] [font-variant-numeric:tabular-nums]"
      >
        {code}
      </span>
    </div>
  );
}
