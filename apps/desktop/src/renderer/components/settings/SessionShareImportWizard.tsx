/**
 * SessionShareImportWizard — .cshare(含旧 .xdtshare)会话导入向导。
 *
 * 三段式驱动 main 的 draft 流程(业务全在 main 的 session-share/sessionShareImport.ts):
 *   inspect(选文件或拖入路径)→ [unlock 密码] → 预览 + [project 会话选 workdir]
 *   → commit → 结果页(按实际保真度诚实分级 + 「打开会话」)。
 * commit 撞上 SHARE_CONFLICT(同 resume id 的存活会话已存在)时转 conflict 确认步:
 * 用户确认「覆盖导入」则带 overwrite 重新 commit(main 软删旧会话后替换导入),
 * 取消回 preview。
 * workdir 步为最简方案(用户拍板):只展示原目录提示,用户自选,唯一硬校验在
 * main(目录存在可读);不做 git 指纹/一致性比对。
 * 视觉复用 ConfirmDialog 的 --confirm-* token 组。
 */

import * as AlertDialog from '@radix-ui/react-alert-dialog';
import { Eye, EyeOff, FolderOpen, ShieldAlert } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { cn } from '@/lib/utils';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/lib/toast';
import { createLogger } from '@/lib/logger';
import { emitRefresh } from '@/lib/sessionsBus';
import { extractIpcError } from '@/utils/ipcError';
import { getDraft, getFastModeForModel } from '@/state/newMakerDraft';

const log = createLogger('SessionShareImportWizard');

type WizardStep = 'picking' | 'password' | 'preview' | 'conflict' | 'committing' | 'done';

export interface SessionShareImportWizardProps {
  open: boolean;
  /** 拖入窗口时的文件路径;缺省则 inspect 弹系统打开对话框。 */
  initialFilePath?: string | null;
  onOpenChange: (open: boolean) => void;
}

export function SessionShareImportWizard({
  open,
  initialFilePath,
  onOpenChange,
}: SessionShareImportWizardProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [step, setStep] = useState<WizardStep>('picking');
  const [draftId, setDraftId] = useState<string | null>(null);
  const [preview, setPreview] = useState<SessionSharePreview | null>(null);
  const [password, setPassword] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [passwordError, setPasswordError] = useState(false);
  const [unlocking, setUnlocking] = useState(false);
  const [workingDir, setWorkingDir] = useState('');
  // 在 worktree 中创建(仅 project 会话):默认不勾;勾选后 main 在 commit 编排里
  // 以所选目录的仓库根建 worktree,导入会话 workingDir 指向 worktree——与 New Maker
  // 草稿开 worktree 创建同语义。
  const [useWorktree, setUseWorktree] = useState(false);
  const [result, setResult] = useState<{
    sessionId: string;
    fidelity: 'full' | 'partial' | 'db-only';
    notes: string[];
  } | null>(null);
  const startedRef = useRef(false);
  const draftIdRef = useRef<string | null>(null);

  useEffect(() => {
    draftIdRef.current = draftId;
  }, [draftId]);

  useEffect(() => {
    return () => {
      const activeDraftId = draftIdRef.current;
      if (activeDraftId) {
        void window.electronAPI.localDb.sessionShare.cancel({ draftId: activeDraftId });
      }
    };
  }, []);

  const closeAndReset = useCallback(
    (opts?: { keepDraft?: boolean }) => {
      if (draftId && !opts?.keepDraft) {
        void window.electronAPI.localDb.sessionShare.cancel({ draftId });
      }
      draftIdRef.current = null;
      setStep('picking');
      setDraftId(null);
      setPreview(null);
      setPassword('');
      setShowPass(false);
      setPasswordError(false);
      setUnlocking(false);
      setWorkingDir('');
      setUseWorktree(false);
      setResult(null);
      startedRef.current = false;
      onOpenChange(false);
    },
    [draftId, onOpenChange],
  );

  const handleError = useCallback(
    (err: unknown) => {
      log.warn('session share import failed', err);
      const ipcError = extractIpcError(err);
      toast.error(
        ipcError
          ? t(`sessionShare.error.${ipcError.code}`, t('sessionShare.import.failed'))
          : t('sessionShare.import.failed'),
      );
    },
    [t],
  );

  // 打开即发起 inspect(拖入路径直接传;按钮路径由 main 弹文件对话框)。
  useEffect(() => {
    if (!open || startedRef.current) return;
    startedRef.current = true;
    let disposed = false;
    void (async () => {
      try {
        const res = await window.electronAPI.localDb.sessionShare.inspect(
          initialFilePath ? { filePath: initialFilePath } : undefined,
        );
        if (disposed) {
          if ('draftId' in res) {
            void window.electronAPI.localDb.sessionShare.cancel({ draftId: res.draftId });
          }
          return;
        }
        if ('status' in res && res.status === 'canceled') {
          closeAndReset();
          return;
        }
        if ('encrypted' in res && res.encrypted) {
          draftIdRef.current = res.draftId;
          setDraftId(res.draftId);
          setStep('password');
          return;
        }
        if ('encrypted' in res && !res.encrypted) {
          draftIdRef.current = res.draftId;
          setDraftId(res.draftId);
          setPreview(res.preview);
          setStep('preview');
        }
      } catch (err) {
        if (disposed) return;
        handleError(err);
        closeAndReset();
      }
    })();
    return () => {
      disposed = true;
    };
  }, [open, initialFilePath, closeAndReset, handleError]);

  const handleUnlock = useCallback(async () => {
    if (!draftId || !password) return;
    setUnlocking(true);
    setPasswordError(false);
    try {
      const res = await window.electronAPI.localDb.sessionShare.unlock({ draftId, password });
      setPreview(res);
      setStep('preview');
    } catch (err) {
      const ipcError = extractIpcError(err);
      if (ipcError?.code === 'SHARE_PASSWORD_WRONG') {
        setPasswordError(true);
      } else {
        handleError(err);
        closeAndReset();
      }
    } finally {
      setUnlocking(false);
    }
  }, [draftId, password, closeAndReset, handleError]);

  const handlePickWorkdir = useCallback(async () => {
    const res = await window.electronAPI.dialog.showOpenDirectory();
    if (res.success && res.path) setWorkingDir(res.path);
  }, []);

  const handleCommit = useCallback(
    async (overwrite = false) => {
      if (!draftId) return;
      setStep('committing');
      try {
        // 导入语义 = 用本地草稿默认值新建会话(只有 agent 跟随分享包):把 New Maker
        // 草稿里该 vendor 的偏好随 commit 传给 main,替代分享包 snapshot 的会话配置
        // (导出方的模型/供应商在导入端不一定存在)。
        const vendor = preview?.agentKind === 'codex' || preview?.agentKind === 'pi'
          ? preview.agentKind
          : 'cc';
        const prefs = getDraft().lastByVendor[vendor];
        const res = await window.electronAPI.localDb.sessionShare.commit({
          draftId,
          ...(preview?.workspaceKind === 'project' ? { workingDir } : {}),
          draftPrefs: {
            model: prefs.model,
            effort: prefs.effort,
            permissionMode: prefs.permissionMode,
            planMode: prefs.planMode,
            fastMode: getFastModeForModel(prefs.model),
            providerId: prefs.providerId ?? null,
          },
          ...(preview?.workspaceKind === 'project' && useWorktree ? { useWorktree: true } : {}),
          ...(overwrite ? { overwrite: true } : {}),
        });
        setResult(res);
        setStep('done');
        emitRefresh();
      } catch (err) {
        const ipcError = extractIpcError(err);
        if (ipcError?.code === 'SHARE_CONFLICT' && !overwrite) {
          // 同 resume id 的存活会话已存在:转冲突确认步,由用户决定覆盖或放弃。
          setStep('conflict');
          return;
        }
        handleError(err);
        setStep('preview');
      }
    },
    [draftId, preview, workingDir, useWorktree, handleError],
  );

  const handleOpenSession = useCallback(() => {
    const sessionId = result?.sessionId;
    closeAndReset({ keepDraft: true });
    if (sessionId) navigate(`/cc-agent/${sessionId}`);
  }, [result, closeAndReset, navigate]);

  const needWorkdir = preview?.workspaceKind === 'project';
  const canCommit = step === 'preview' && (!needWorkdir || workingDir.trim().length > 0);
  const busy = step === 'committing' || unlocking;

  // picking 阶段(main 正在弹文件对话框)不渲染弹窗本体,避免双层遮罩。
  if (!open || step === 'picking') return null;

  return (
    <AlertDialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) closeAndReset();
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Overlay
          className={cn(
            'fixed inset-0 z-[10000]',
            'bg-[var(--overlay-modal)]',
            'data-[state=open]:animate-confirm-overlay-in',
            'data-[state=closed]:animate-confirm-overlay-out',
          )}
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        />
        <AlertDialog.Content
          className={cn(
            'fixed left-1/2 top-1/2 z-[10000] -translate-x-1/2 -translate-y-1/2',
            'w-full max-w-[480px] rounded-xl p-4',
            'bg-[var(--confirm-bg)] shadow-[var(--confirm-shadow)]',
            'data-[state=open]:animate-confirm-content-in',
            'data-[state=closed]:animate-confirm-content-out',
          )}
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          onEscapeKeyDown={(e) => {
            if (busy) e.preventDefault();
          }}
        >
          <AlertDialog.Title className="text-lg font-medium text-[var(--confirm-title)]">
            {t('sessionShare.import.title')}
          </AlertDialog.Title>

          {step === 'password' && (
            <div className="mt-3 flex flex-col gap-2">
              <AlertDialog.Description className="text-sm text-[var(--confirm-desc)]">
                {t('sessionShare.import.passwordPrompt')}
              </AlertDialog.Description>
              <div className="relative">
                <input
                  type={showPass ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    setPasswordError(false);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && password && !unlocking) void handleUnlock();
                  }}
                  placeholder={t('sessionShare.import.passwordPlaceholder')}
                  autoFocus
                  disabled={unlocking}
                  className="h-8 w-full rounded-md border bg-transparent px-2 pr-8 text-sm outline-none"
                  style={{
                    borderColor: passwordError ? 'var(--error-border)' : 'var(--border-default)',
                    color: 'var(--confirm-title)',
                  }}
                />
                <button
                  type="button"
                  onClick={() => setShowPass((v) => !v)}
                  aria-label={t(showPass ? 'sessionShare.export.hidePassword' : 'sessionShare.export.showPassword')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
                >
                  {showPass ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
              {passwordError && (
                <p className="text-xs" style={{ color: 'var(--error-fg)' }}>
                  {t('sessionShare.error.SHARE_PASSWORD_WRONG')}
                </p>
              )}
            </div>
          )}

          {(step === 'preview' || step === 'committing') && preview && (
            <div className="mt-3 flex flex-col gap-3">
              <div
                className="rounded-lg p-3 text-sm"
                style={{ backgroundColor: 'var(--surface-chip)', color: 'var(--confirm-title)' }}
              >
                <p className="font-medium truncate">{preview.title}</p>
                <p className="mt-1 text-xs text-[var(--text-tertiary)]">
                  {t('sessionShare.import.previewMeta', {
                    agent: preview.agentKind === 'cc'
                      ? 'Claude Code'
                      : preview.agentKind === 'pi'
                        ? 'Pi'
                        : 'Codex',
                    count: preview.messageCount,
                    exportedAt: new Date(preview.exportedAt).toLocaleString(),
                  })}
                </p>
                <p className="mt-1 text-xs text-[var(--text-tertiary)]">
                  {t(`sessionShare.fidelity.${preview.fidelity}`)}
                </p>
              </div>

              {/* 风险提示:分享包来自他人,历史内容可能影响 AI 后续行为,续聊时
                  agent 具备本机文件读写与命令执行能力——确认导入前必须让用户知情。 */}
              <div className="flex items-start gap-2 rounded-md bg-[var(--warning-bg-soft)] px-3 py-2">
                <ShieldAlert
                  size={14}
                  className="mt-0.5 shrink-0 text-[var(--confirm-desc)]"
                  aria-hidden
                />
                <p className="text-xs text-[var(--confirm-desc)]">
                  {t('sessionShare.import.riskWarning')}
                </p>
              </div>

              {needWorkdir && (
                <div className="flex flex-col gap-1.5">
                  {/* originalDir 是他机路径,可能是无空格长串:break-words 防止顶破弹窗宽度 */}
                  <p className="break-words text-sm text-[var(--confirm-desc)]">
                    {t('sessionShare.import.workdirHint', {
                      originalDir: preview.originalWorkingDir ?? '-',
                    })}
                  </p>
                  <div className="flex items-center gap-2">
                    <div
                      title={workingDir || undefined}
                      className="h-8 min-w-0 flex-1 truncate rounded-md border px-2 text-sm leading-8"
                      style={{
                        borderColor: 'var(--border-default)',
                        color: workingDir ? 'var(--confirm-title)' : 'var(--text-tertiary)',
                      }}
                    >
                      {workingDir || t('sessionShare.import.workdirEmpty')}
                    </div>
                    <button
                      type="button"
                      onClick={() => void handlePickWorkdir()}
                      disabled={busy}
                      className={cn(
                        'inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-sm',
                        'text-[var(--confirm-btn-secondary-text)] border-[var(--confirm-btn-secondary-border)]',
                        'hover:bg-[var(--confirm-btn-secondary-hover)]',
                      )}
                    >
                      <FolderOpen size={14} aria-hidden />
                      {t('sessionShare.import.pickWorkdir')}
                    </button>
                  </div>
                  {/* 与 confirm-dialog 的 checkbox 约定一致:原生 input + size-3.5 +
                      accent 主题 token(项目没有统一 Checkbox 组件,这是现行范式)。 */}
                  <label className="mt-1 flex cursor-pointer select-none items-start gap-2">
                    <input
                      type="checkbox"
                      checked={useWorktree}
                      onChange={(e) => setUseWorktree(e.target.checked)}
                      disabled={busy}
                      className="mt-[3px] size-3.5 cursor-pointer accent-[var(--confirm-btn-primary-bg)]"
                    />
                    <span className="flex flex-col gap-0.5">
                      <span className="text-sm text-[var(--confirm-title)]">
                        {t('sessionShare.import.useWorktree')}
                      </span>
                      <span className="text-xs text-[var(--text-tertiary)]">
                        {t('sessionShare.import.useWorktreeHint')}
                      </span>
                    </span>
                  </label>
                </div>
              )}
            </div>
          )}

          {step === 'conflict' && (
            <div className="mt-3 flex flex-col gap-2">
              <p className="text-sm font-medium text-[var(--confirm-title)]">
                {t('sessionShare.import.conflictTitle')}
              </p>
              <AlertDialog.Description className="text-sm text-[var(--confirm-desc)]">
                {t('sessionShare.import.conflictBody')}
              </AlertDialog.Description>
            </div>
          )}

          {step === 'done' && result && (
            <div className="mt-3 flex flex-col gap-2">
              <p className="text-sm text-[var(--confirm-title)]">
                {t('sessionShare.import.doneTitle')}
              </p>
              <p className="text-sm text-[var(--confirm-desc)]">
                {t(`sessionShare.fidelityResult.${result.fidelity}`)}
              </p>
              {result.notes.map((note) => (
                <p key={note} className="text-xs text-[var(--text-tertiary)]">
                  {t(`sessionShare.note.${note}`, note)}
                </p>
              ))}
            </div>
          )}

          <div className="mt-5 flex justify-end gap-2">
            {step !== 'done' && step !== 'conflict' && (
              <AlertDialog.Cancel asChild>
                <button
                  type="button"
                  disabled={busy}
                  className={cn(
                    'h-8 rounded-lg border px-3 text-sm font-medium',
                    'text-[var(--confirm-btn-secondary-text)] border-[var(--confirm-btn-secondary-border)]',
                    'hover:bg-[var(--confirm-btn-secondary-hover)]',
                  )}
                >
                  {t('sessionShare.import.cancel')}
                </button>
              </AlertDialog.Cancel>
            )}

            {step === 'password' && (
              <button
                type="button"
                disabled={!password || unlocking}
                onClick={() => void handleUnlock()}
                className={cn(
                  'h-8 rounded-lg px-3 text-sm font-medium inline-flex items-center gap-1.5',
                  'text-[var(--confirm-btn-primary-text)] bg-[var(--confirm-btn-primary-bg)]',
                  'hover:bg-[var(--confirm-btn-primary-hover)]',
                  (!password || unlocking) && 'opacity-50 cursor-not-allowed',
                )}
              >
                {unlocking && <Spinner size={14} />}
                {t('sessionShare.import.unlock')}
              </button>
            )}

            {step === 'conflict' && (
              <>
                <button
                  type="button"
                  onClick={() => setStep('preview')}
                  className={cn(
                    'h-8 rounded-lg border px-3 text-sm font-medium',
                    'text-[var(--confirm-btn-secondary-text)] border-[var(--confirm-btn-secondary-border)]',
                    'hover:bg-[var(--confirm-btn-secondary-hover)]',
                  )}
                >
                  {t('sessionShare.import.conflictCancel')}
                </button>
                <button
                  type="button"
                  onClick={() => void handleCommit(true)}
                  className={cn(
                    'h-8 rounded-lg px-3 text-sm font-medium',
                    'text-[var(--confirm-btn-primary-text)] bg-[var(--confirm-btn-primary-bg)]',
                    'hover:bg-[var(--confirm-btn-primary-hover)]',
                  )}
                >
                  {t('sessionShare.import.conflictOverwrite')}
                </button>
              </>
            )}

            {(step === 'preview' || step === 'committing') && (
              <button
                type="button"
                disabled={!canCommit || busy}
                onClick={() => void handleCommit()}
                className={cn(
                  'h-8 rounded-lg px-3 text-sm font-medium inline-flex items-center gap-1.5',
                  'text-[var(--confirm-btn-primary-text)] bg-[var(--confirm-btn-primary-bg)]',
                  'hover:bg-[var(--confirm-btn-primary-hover)]',
                  (!canCommit || busy) && 'opacity-50 cursor-not-allowed',
                )}
              >
                {step === 'committing' && <Spinner size={14} />}
                {t('sessionShare.import.confirm')}
              </button>
            )}

            {step === 'done' && (
              <>
                <button
                  type="button"
                  onClick={() => closeAndReset({ keepDraft: true })}
                  className={cn(
                    'h-8 rounded-lg border px-3 text-sm font-medium',
                    'text-[var(--confirm-btn-secondary-text)] border-[var(--confirm-btn-secondary-border)]',
                    'hover:bg-[var(--confirm-btn-secondary-hover)]',
                  )}
                >
                  {t('sessionShare.import.close')}
                </button>
                <button
                  type="button"
                  onClick={handleOpenSession}
                  className={cn(
                    'h-8 rounded-lg px-3 text-sm font-medium',
                    'text-[var(--confirm-btn-primary-text)] bg-[var(--confirm-btn-primary-bg)]',
                    'hover:bg-[var(--confirm-btn-primary-hover)]',
                  )}
                >
                  {t('sessionShare.import.openSession')}
                </button>
              </>
            )}
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
