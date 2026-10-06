import * as Dialog from '@radix-ui/react-dialog';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Info, X } from 'lucide-react';

import { WINDOW_DRAG_STYLE, WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';
import { Button } from '@/components/ui/button';
import { Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import {
  ORCA_PREDEFINED_WORKER_ROLES as PREDEFINED_ROLES,
  normalizeOrcaWorkerLabel,
} from '@cindy/maker-shared/orca-team';

import type { WorkerInfo } from './hooks/useWorkers';

export interface EditWorkerForm {
  role: string;
  /** 空白表示不改动当前 label（不提供「清空 label」语义）。 */
  label: string;
}

export interface EditWorkerPopoverProps {
  open: boolean;
  worker: WorkerInfo | null;
  onClose: () => void;
  /**
   * 保存。返回 true 表示成功（调用方负责关闭）；false 表示失败保持编辑态。
   * 失败文案由调用方统一 toast。
   */
  onSave: (form: EditWorkerForm) => Promise<boolean>;
}

/**
 * EditWorkerPopover —— 创建后修改 Worker 的角色名(role)与 team 内唯一标识(label)。
 *
 * 只改身份元数据：Agent / 模型 / 权限不在这里，避免把「改名」误做成重建执行单元
 * (model 中途切换是 Orca 的禁止项)。视觉与 CreateWorkerPopover 同族。
 */
export function EditWorkerPopover({
  open,
  worker,
  onClose,
  onSave,
}: EditWorkerPopoverProps) {
  const { t } = useTranslation();
  const [role, setRole] = useState('');
  const [customRole, setCustomRole] = useState('');
  const [label, setLabel] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const roleInputRef = useRef<HTMLInputElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  /** 已用哪个 worker 初始化过表单。投影刷新会换 worker 对象身份，不能用它触发重置，
   * 否则用户编辑到一半会被后台刷新静默回滚。 */
  const initializedWorkerIdRef = useRef<string | null>(null);

  // 打开（或切换到另一个 worker）时按当前值重置表单；同一 worker 的投影刷新不重置。
  useEffect(() => {
    if (!open) {
      initializedWorkerIdRef.current = null;
      submittingRef.current = false;
      setIsSubmitting(false);
      return;
    }
    if (!worker || initializedWorkerIdRef.current === worker.workerId) return;
    initializedWorkerIdRef.current = worker.workerId;
    const predefined = (PREDEFINED_ROLES as readonly string[]).includes(worker.role);
    setRole(predefined ? worker.role : '');
    setCustomRole(predefined ? '' : worker.role);
    setLabel(worker.label ?? '');
    submittingRef.current = false;
    setIsSubmitting(false);
  }, [open, worker]);

  const activeRole = customRole || role;
  const customRoleError =
    customRole.length > 0 && (PREDEFINED_ROLES as readonly string[]).includes(customRole)
      ? t('orca.createWorker.customRolePredefinedError')
      : null;
  const trimmedLabel = label.trim();
  const labelValidation = trimmedLabel ? normalizeOrcaWorkerLabel(trimmedLabel) : null;
  const labelError = labelValidation?.ok === false ? t('orca.editWorker.labelInvalid') : null;
  const canSave =
    !isSubmitting &&
    !!worker &&
    activeRole.length >= 1 &&
    activeRole.length <= 32 &&
    !customRoleError &&
    !labelError;

  const handleClose = useCallback(() => {
    if (!submittingRef.current) onClose();
  }, [onClose]);

  const handleSave = useCallback(async () => {
    if (!canSave || submittingRef.current) return;
    submittingRef.current = true;
    setIsSubmitting(true);
    try {
      const ok = await onSave({ role: activeRole, label: trimmedLabel });
      if (!ok) {
        submittingRef.current = false;
        setIsSubmitting(false);
      }
    } catch {
      // onSave 失败已在调用方统一 toast；回到可编辑态。
      submittingRef.current = false;
      setIsSubmitting(false);
    }
  }, [activeRole, canSave, onSave, trimmedLabel]);

  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next) handleClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-scrim fixed inset-0 z-50 flex items-center justify-center" style={WINDOW_DRAG_STYLE}>
          <Dialog.Content
            className="modal-panel relative z-10 w-[460px] max-w-[calc(100vw-32px)] p-6 outline-none"
            aria-describedby={undefined}
            onPointerDownOutside={(event) => event.preventDefault()}
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
              roleInputRef.current?.focus();
            }}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              if (openerRef.current?.isConnected) openerRef.current.focus({ preventScroll: true });
            }}
            onEscapeKeyDown={(event) => {
              if (submittingRef.current || event.isComposing || event.keyCode === 229) event.preventDefault();
            }}
            style={WINDOW_NO_DRAG_STYLE}
          >
            <div className="mb-5 flex items-center justify-between">
              <Dialog.Title asChild>
                <span className="text-16 font-medium text-[var(--text-primary)]">
                  {t('orca.editWorker.title')}
                </span>
              </Dialog.Title>
              <button
                type="button"
                aria-label={t('orca.editWorker.closeAria')}
                className="inline-flex h-6 w-6 items-center justify-center rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
                disabled={isSubmitting}
                onClick={handleClose}
              >
                <X size={15} />
              </button>
            </div>

            <div className="mb-4">
              <div className="mb-2 flex items-center gap-1">
                <span className="text-12 font-medium uppercase tracking-[0.5px] text-[var(--text-tertiary)]">
                  {t('orca.createWorker.roleLabel')}
                </span>
                <Tip
                  text={t('orca.createWorker.roleHint')}
                  side="top"
                  contentClassName="max-w-[280px] whitespace-normal break-words text-left"
                >
                  <button
                    type="button"
                    className={cn(
                      'inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-0 bg-transparent p-0',
                      'text-[var(--text-tertiary)] outline-none transition-colors',
                      'hover:bg-[var(--surface-hover)] hover:text-[var(--text-secondary)]',
                      'focus:bg-[var(--surface-hover)] focus:text-[var(--text-secondary)]',
                    )}
                    aria-label={t('orca.createWorker.roleHintAria')}
                  >
                    <Info size={13} aria-hidden />
                  </button>
                </Tip>
              </div>
              <div className="flex flex-wrap gap-2">
                {PREDEFINED_ROLES.map((r) => (
                  <button
                    key={r}
                    type="button"
                    className={cn(
                      'rounded-full px-3 py-1.5 text-13 leading-none border transition-colors',
                      activeRole === r
                        ? 'bg-[var(--surface-chip)] border-[var(--text-secondary)] text-[var(--text-primary)] font-medium'
                        : 'border-[var(--border-default)] text-[var(--text-secondary)] hover:bg-[var(--surface-chip)]',
                    )}
                    onClick={() => {
                      setRole(r);
                      setCustomRole('');
                    }}
                  >
                    {r}
                  </button>
                ))}
              </div>
              <input
                ref={roleInputRef}
                type="text"
                className="mt-2 w-full rounded-full border border-[var(--border-default)] bg-transparent px-3 py-1.5 text-13 leading-none text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] outline-none focus:border-[var(--text-secondary)]"
                placeholder={t('orca.createWorker.customRolePlaceholder')}
                value={customRole}
                maxLength={32}
                onChange={(e) => {
                  setCustomRole(e.target.value);
                  setRole('');
                }}
              />
              {customRoleError && (
                <div className="mt-1 text-11 text-[var(--error-fg)]">{customRoleError}</div>
              )}
            </div>

            <div className="mb-5">
              <div className="mb-2 flex items-center gap-1">
                <span className="text-12 font-medium uppercase tracking-[0.5px] text-[var(--text-tertiary)]">
                  {t('orca.editWorker.labelLabel')}
                </span>
                <Tip
                  text={t('orca.editWorker.labelHint')}
                  side="top"
                  contentClassName="max-w-[280px] whitespace-normal break-words text-left"
                >
                  <button
                    type="button"
                    className={cn(
                      'inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-0 bg-transparent p-0',
                      'text-[var(--text-tertiary)] outline-none transition-colors',
                      'hover:bg-[var(--surface-hover)] hover:text-[var(--text-secondary)]',
                      'focus:bg-[var(--surface-hover)] focus:text-[var(--text-secondary)]',
                    )}
                    aria-label={t('orca.editWorker.labelHintAria')}
                  >
                    <Info size={13} aria-hidden />
                  </button>
                </Tip>
              </div>
              <input
                type="text"
                className="w-full rounded-full border border-[var(--border-default)] bg-transparent px-3 py-1.5 text-13 leading-none text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] outline-none focus:border-[var(--text-secondary)]"
                placeholder={t('orca.editWorker.labelPlaceholder')}
                value={label}
                maxLength={32}
                spellCheck={false}
                autoCapitalize="none"
                autoCorrect="off"
                onChange={(e) => setLabel(e.target.value)}
              />
              {labelError && (
                <div className="mt-1 text-11 text-[var(--error-fg)]">{labelError}</div>
              )}
            </div>

            <Button
              variant="cta"
              palette="confirmation"
              size="lg"
              loading={isSubmitting}
              type="button"
              className="w-full"
              disabled={!canSave}
              aria-busy={isSubmitting}
              onClick={() => void handleSave()}
            >
              {t('orca.editWorker.submit')}
            </Button>
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
