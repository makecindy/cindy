/**
 * SessionShareExportDialog — 会话导出为 .cshare 的确认弹窗。
 *
 * 职责(纯 UI,业务全在 main 的 session-share/sessionShareExport.ts):
 *   1. 敏感内容确认:导出包含完整工具输出(文件内容、命令结果),提醒用户自查;
 *   2. 可选密码:勾选后输入 + 确认 + 显隐(表单模式对齐 SshKeySetupDialog);
 *   3. 调 sessionShare.export IPC —— 系统保存对话框由 main 弹出;
 *   4. 结果反馈:成功按保真度分级 toast;超限提供「排除媒体重试」;取消静默。
 *
 * 视觉复用 ConfirmDialog 的 --confirm-* token 组(同 CrossAgentConvertDialog)。
 */

import * as AlertDialog from '@radix-ui/react-alert-dialog';
import { Eye, EyeOff } from 'lucide-react';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { Spinner } from '@/components/ui/spinner';
import { Tip } from '@/components/ui/tooltip';
import { toast } from '@/lib/toast';
import { createLogger } from '@/lib/logger';
import { extractIpcError } from '@/utils/ipcError';

const log = createLogger('SessionShareExportDialog');

export interface SessionShareExportDialogProps {
  open: boolean;
  sessionId: string;
  onOpenChange: (open: boolean) => void;
}

export function SessionShareExportDialog({
  open,
  sessionId,
  onOpenChange,
}: SessionShareExportDialogProps) {
  const { t } = useTranslation();
  const [encrypt, setEncrypt] = useState(false);
  const [pass, setPass] = useState('');
  const [passConfirm, setPassConfirm] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [exporting, setExporting] = useState(false);
  /** 超限一次后置 true:下次导出带 excludeMedia 重试。 */
  const [excludeMedia, setExcludeMedia] = useState(false);
  const [oversizeMediaMb, setOversizeMediaMb] = useState<number | null>(null);

  const mismatch = encrypt && pass.length > 0 && passConfirm.length > 0 && pass !== passConfirm;
  const tooShort = encrypt && pass.length > 0 && pass.length < 4;
  const canSubmit = !exporting && (!encrypt || (pass.length >= 4 && pass === passConfirm));

  const resetAndClose = useCallback(() => {
    setEncrypt(false);
    setPass('');
    setPassConfirm('');
    setShowPass(false);
    setExporting(false);
    setExcludeMedia(false);
    setOversizeMediaMb(null);
    onOpenChange(false);
  }, [onOpenChange]);

  const handleExport = useCallback(async () => {
    setExporting(true);
    try {
      const result = await window.electronAPI.localDb.sessionShare.export({
        sessionId,
        ...(encrypt && pass ? { password: pass } : {}),
        ...(excludeMedia ? { excludeMedia: true } : {}),
      });
      if (result.status === 'canceled') {
        setExporting(false);
        return; // 用户取消保存对话框:留在弹窗,不打扰
      }
      if (result.status === 'oversize') {
        setExporting(false);
        // 只有「媒体确实占了体积、且还没排除过媒体」时,排除媒体重试才可能奏效;
        // 否则(超限来自消息/转录本身,或已在排除媒体的重试里)如实报无法导出,
        // 不进无效重试循环(review bot 指出)。
        if (result.mediaBytes > 0 && !excludeMedia) {
          setExcludeMedia(true);
          setOversizeMediaMb(Math.round(result.mediaBytes / (1024 * 1024)));
        } else {
          toast.error(
            t('sessionShare.export.tooLarge', {
              limitMb: Math.round(result.limitBytes / (1024 * 1024)),
            }),
          );
        }
        return;
      }
      const fidelityKey =
        result.fidelity === 'full'
          ? 'sessionShare.export.doneFull'
          : result.fidelity === 'partial'
            ? 'sessionShare.export.donePartial'
            : 'sessionShare.export.doneDbOnly';
      if (result.fidelity === 'full') toast.success(t(fidelityKey));
      else toast.warning(t(fidelityKey));
      resetAndClose();
    } catch (err) {
      log.warn('session share export failed', err);
      const ipcError = extractIpcError(err);
      toast.error(
        ipcError
          ? t(`sessionShare.error.${ipcError.code}`, t('sessionShare.export.failed'))
          : t('sessionShare.export.failed'),
      );
      setExporting(false);
    }
  }, [sessionId, encrypt, pass, excludeMedia, resetAndClose, t]);

  return (
    <AlertDialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && !exporting) resetAndClose();
      }}
    >
      <AlertDialog.Portal>
        {/* Radix Portal 只搬 DOM 不搬 React 树:本弹窗仍是 SessionItem 行的 React
            子节点,click / keydown 会沿 React 树冒泡触发行的选中导航(review bot
            指出;密码框里敲空格/回车同样会命中行的 onKeyDown)。Overlay 与 Content
            统一截断冒泡。 */}
        <AlertDialog.Overlay
          className={cn(
            'fixed inset-0 z-[10000]',
            'bg-[var(--overlay-modal)]',
            'data-[state=open]:animate-confirm-overlay-in',
            'data-[state=closed]:animate-confirm-overlay-out',
          )}
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        />
        <AlertDialog.Content
          className={cn(
            'fixed left-1/2 top-1/2 z-[10000] -translate-x-1/2 -translate-y-1/2',
            'w-full max-w-[440px] rounded-xl p-4',
            'bg-[var(--confirm-bg)] shadow-[var(--confirm-shadow)]',
            'data-[state=open]:animate-confirm-content-in',
            'data-[state=closed]:animate-confirm-content-out',
          )}
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          onEscapeKeyDown={(e) => {
            if (exporting) e.preventDefault();
          }}
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <AlertDialog.Title className="text-lg font-medium text-[var(--confirm-title)]">
            {t('sessionShare.export.title')}
          </AlertDialog.Title>
          <AlertDialog.Description className="mt-2 text-sm text-[var(--confirm-desc)]">
            {t('sessionShare.export.sensitiveWarning')}
          </AlertDialog.Description>

          {oversizeMediaMb !== null && (
            <p className="mt-2 text-sm text-[var(--confirm-desc)]">
              {t('sessionShare.export.oversizeHint', { mediaMb: oversizeMediaMb })}
            </p>
          )}

          <label className="mt-4 flex items-start gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={encrypt}
              onChange={(e) => setEncrypt(e.target.checked)}
              disabled={exporting}
              className="mt-0.5 accent-[var(--confirm-btn-primary-bg)]"
            />
            <span className="text-sm text-[var(--confirm-title)]">
              {t('sessionShare.export.encryptLabel')}
            </span>
          </label>

          {encrypt && (
            <div className="mt-3 flex flex-col gap-2">
              <div className="relative">
                <input
                  type={showPass ? 'text' : 'password'}
                  value={pass}
                  onChange={(e) => setPass(e.target.value)}
                  placeholder={t('sessionShare.export.passwordPlaceholder')}
                  disabled={exporting}
                  autoFocus
                  className="h-8 w-full rounded-md border bg-transparent px-2 pr-8 text-sm outline-none"
                  style={{
                    borderColor: 'var(--border-default)',
                    color: 'var(--confirm-title)',
                  }}
                />
                <Tip
                  text={t(
                    showPass
                      ? 'sessionShare.export.hidePassword'
                      : 'sessionShare.export.showPassword',
                  )}
                  side="bottom"
                  contentClassName="z-[10001]"
                >
                  <button
                    type="button"
                    onClick={() => setShowPass((v) => !v)}
                    aria-label={t(
                      showPass
                        ? 'sessionShare.export.hidePassword'
                        : 'sessionShare.export.showPassword',
                    )}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
                  >
                    {showPass ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </Tip>
              </div>
              <input
                type={showPass ? 'text' : 'password'}
                value={passConfirm}
                onChange={(e) => setPassConfirm(e.target.value)}
                placeholder={t('sessionShare.export.passwordConfirmPlaceholder')}
                disabled={exporting}
                className="h-8 w-full rounded-md border bg-transparent px-2 text-sm outline-none"
                style={{
                  borderColor: mismatch ? 'var(--error-border)' : 'var(--border-default)',
                  color: 'var(--confirm-title)',
                }}
              />
              {(mismatch || tooShort) && (
                <p className="text-xs" style={{ color: 'var(--error-fg)' }}>
                  {t(
                    mismatch
                      ? 'sessionShare.export.passwordMismatch'
                      : 'sessionShare.export.passwordTooShort',
                  )}
                </p>
              )}
            </div>
          )}

          <div className="mt-5 flex justify-end gap-2">
            <AlertDialog.Cancel asChild>
              <button
                type="button"
                disabled={exporting}
                className={cn(
                  'h-8 rounded-lg px-3 text-sm font-medium',
                  'text-[var(--confirm-btn-secondary-text)] bg-[var(--confirm-bg)]',
                  'hover:bg-[var(--confirm-btn-secondary-hover)]',
                )}
              >
                {t('sessionShare.export.cancel')}
              </button>
            </AlertDialog.Cancel>
            <button
              type="button"
              disabled={!canSubmit}
              onClick={() => void handleExport()}
              className={cn(
                'h-8 rounded-lg px-3 text-sm font-medium inline-flex items-center gap-1.5',
                'text-[var(--confirm-btn-primary-text)] bg-[var(--confirm-btn-primary-bg)]',
                'hover:bg-[var(--confirm-btn-primary-hover)]',
                !canSubmit && 'opacity-50 cursor-not-allowed',
              )}
            >
              {exporting && <Spinner size={14} />}
              {t(
                oversizeMediaMb !== null
                  ? 'sessionShare.export.confirmExcludeMedia'
                  : 'sessionShare.export.confirm',
              )}
            </button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
