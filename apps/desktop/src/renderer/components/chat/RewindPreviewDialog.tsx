import { FileTypeIcon } from '@/components/ui/file-type-icon';
/**
 * RewindPreviewDialog
 * ---------------------------------------------------------------------------
 * 5 状态对话框（Running / Loading / Default / Empty / Error），共享同一套结构与视觉规格。
 *
 * 流程：
 *   open=true + running → 直接确认 Stop + Rewind，不读取会立刻过期的 preview
 *   open=true + idle    → 进 Loading → 调 rewindPreview(sessionId, clientId)
 *               ├─ filesChanged.length > 0       → Default（文件清单 + summary）
 *               ├─ conversationOnly              → Empty（说明文件恢复不可用）
 *               ├─ filesChanged.length == 0      → Empty（无文件改动）
 *               └─ canRewind=false 或抛错        → Error（红色 alert + "知道了"）
 *
 *   Confirm 点击（Running / Default / Empty）→ 调 rewindCommit(stopIfRunning=true)
 *             Empty 额外传 allowFileRestore:false，绑定预览时的 conversation-only 承诺
 *                                             → 成功后 onCommitted(session)
 *                                                  → 失败 toast.error 但保持弹窗开
 *
 * 不负责：composer 预填、消息列表重拉、sidebar 同步——这些由调用方
 * （UserMessage）在 onCommitted 回调里串起来，因为它知道 user 消息原文。
 *
 * SDK 限制：RewindFilesResult 只给 filesChanged: string[] + 总 insertions/deletions，
 * 不给 per-file diff 数据。每行只显路径，cursor-default 不可点（hover tooltip 提示）。
 */

import { useCallback, useEffect, useState } from 'react';
import * as AlertDialog from '@radix-ui/react-alert-dialog';
import { FileText, TriangleAlert, Undo2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';

import { cn } from '@/lib/utils';
import { Spinner } from '@/components/ui/spinner';
import { Tooltip } from '@/components/ui/tooltip';
import { ApiError } from '@/lib/httpClient';
import { rewindPreview, rewindCommit } from '@/lib/sessionService';
import type { Session } from '@/lib/ccAgent.types';

type DialogState =
  | { kind: 'running' }
  | { kind: 'loading' }
  | {
      kind: 'default';
      filesChanged: string[];
      insertions: number;
      deletions: number;
    }
  // empty: 对话可以回退，但文件层面要么没有改动，要么没有可用的恢复点；
  // note 用于把这两种用户可见结果明确区分。
  | { kind: 'empty'; note?: string }
  // error: 真硬错（IPC 抛错，非 SDK 软拒绝）—— 阻塞 Confirm
  | { kind: 'error'; errorText: string };

interface RewindPreviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string;
  /** clientId of the user message to rewind to (== messages.client_id). */
  clientId: string;
  /** Selects the stop-then-rewind confirmation while a turn is active. */
  sessionRunning: boolean;
  /** Called after a successful commit with the updated session row. The
   *  callback is responsible for composer pre-fill, sidebar bus emit, and
   *  message reload — Dialog is intentionally agnostic. */
  onCommitted: (session: Session) => void;
}

export function RewindPreviewDialog({
  open,
  onOpenChange,
  sessionId,
  clientId,
  sessionRunning,
  onCommitted,
}: RewindPreviewDialogProps) {
  const { t } = useTranslation();
  const [state, setState] = useState<DialogState>(
    sessionRunning ? { kind: 'running' } : { kind: 'loading' },
  );
  const [committing, setCommitting] = useState(false);

  // (Re-)run dryRun every time the dialog opens for a fresh (sessionId, clientId).
  // Dialog instance is re-created per open by parent (key={clientId}), but we
  // also defensively reset state on open transitions.
  useEffect(() => {
    if (!open || committing) return;
    if (sessionRunning) {
      setState({ kind: 'running' });
      setCommitting(false);
      return;
    }
    let cancelled = false;
    setState({ kind: 'loading' });
    setCommitting(false);
    rewindPreview(sessionId, clientId)
      .then((result) => {
        if (cancelled) return;
        const files = result.filesChanged ?? [];
        if (result.canRewind && files.length > 0) {
          setState({
            kind: 'default',
            filesChanged: files,
            insertions: result.insertions ?? 0,
            deletions: result.deletions ?? 0,
          });
        } else if (result.canRewind && result.conversationOnly) {
          // The conversation can still rewind, but there is no file restore
          // plan (for example a non-Git project or missing savepoints).
          setState({
            kind: 'empty',
            note: result.gitSafetyDisabled
              ? t('chat.rewind.gitSafetyDisabledNotice')
              : t('chat.rewind.conversationOnlyNotice'),
          });
        } else if (result.canRewind) {
          // 文件层面没有检测到改动，仍允许用户回退聊天记录。
          setState({ kind: 'empty' });
        } else {
          // SDK 软拒绝（最常见："No file checkpoint found for this message"
          // = 该 user 消息之后没有任何工具改文件；或老 session 没开 checkpointing）。
          // 对话仍可回退，让用户继续 Confirm；具体原因以 note 形式提示。
          setState({
            kind: 'empty',
            note: result.error || t('chat.rewind.noFilesToRollback'),
          });
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const code = err instanceof ApiError ? err.code : 'UNKNOWN';
        // Renderer running state can lag the authoritative main guard by one
        // event. Upgrade that race to the same stop-then-rewind confirmation.
        if (code === 'SESSION_RUNNING') {
          setState({ kind: 'running' });
          return;
        }
        // Other preview-stage errors block confirmation with friendly text.
        const msg =
          code === 'NO_PRIOR_ASSISTANT'
            ? t('chat.rewind.errors.noPriorAssistantPreview')
            : code === 'NO_LIVE_QUERY'
            ? t('chat.rewind.errors.noLiveQuery')
            : err instanceof Error
            ? err.message
            : String(err);
        setState({ kind: 'error', errorText: msg });
      });
    return () => {
      cancelled = true;
    };
  }, [open, sessionId, clientId, sessionRunning, committing, t]);

  const handleConfirm = useCallback(async () => {
    if (committing) return;
    if (state.kind !== 'running' && state.kind !== 'default' && state.kind !== 'empty') return;
    setCommitting(true);
    try {
      const session = await rewindCommit(sessionId, clientId, {
        stopIfRunning: true,
        ...(state.kind === 'empty' ? { allowFileRestore: false } : {}),
      });
      onCommitted(session);
      onOpenChange(false);
    } catch (err) {
      const code = err instanceof ApiError ? err.code : 'UNKNOWN';
      const msg =
        code === 'SESSION_RUNNING'
          ? t('chat.rewind.errors.sessionRunning')
          : code === 'NO_PRIOR_ASSISTANT'
          ? t('chat.rewind.errors.noPriorAssistantCommit')
          : t('chat.rewind.errors.commitGeneric');
      const { toast } = await import('@/lib/toast');
      toast.error(msg);
      // Keep dialog open so the user can Cancel out themselves.
    } finally {
      setCommitting(false);
    }
  }, [committing, state.kind, sessionId, clientId, onCommitted, onOpenChange, t]);

  // Confirm button enabled on running + preview-confirmable states.
  const canConfirm =
    (state.kind === 'running' || state.kind === 'default' || state.kind === 'empty') &&
    !committing;
  const isError = state.kind === 'error';

  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
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
            'w-[640px] rounded-xl p-5',
            // Card 层（同 confirm dialog 用项目变量）
            'bg-[var(--confirm-bg)]',
            // Dark 模式 1px Board 描边（设计稿要求）
            'shadow-[var(--shadow-menu)]',
            'dark:border dark:border-[var(--confirm-btn-secondary-border)]',
            'data-[state=open]:animate-confirm-content-in',
            'data-[state=closed]:animate-confirm-content-out',
          )}
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          {/* Header */}
          <div className="flex flex-col gap-1.5">
            <AlertDialog.Title className="text-18 font-medium text-[var(--confirm-title)]">
              {isError ? t('chat.rewind.dialog.titleError') : t('chat.rewind.dialog.title')}
            </AlertDialog.Title>
            <AlertDialog.Description className="text-14 leading-[1.5] text-[var(--cmd-palette-item-meta)]">
              {isError
                ? t('chat.rewind.dialog.errorDescription')
                : describeSummary(state, t)}
            </AlertDialog.Description>
          </div>

          {/* Body — 容器固定 240px 高，5 状态切换 */}
          <div className="mt-5">
            {state.kind === 'running' && <BodyRunning />}
            {state.kind === 'loading' && <BodyLoading />}
            {state.kind === 'default' && <BodyDefault files={state.filesChanged} />}
            {state.kind === 'empty' && <BodyEmpty note={state.note} />}
            {state.kind === 'error' && <BodyError errorText={state.errorText} />}
          </div>


          {/* Summary（仅 default 显示真实 stats） */}
          {state.kind === 'default' && (
            <div className="mt-3 text-12 text-[var(--settings-section-desc)]">
              {t('chat.rewind.dialog.summaryPrefix', { count: state.filesChanged.length })}
              <span className="text-[var(--diff-add-fg)]">+{state.insertions}</span>
              {' / '}
              <span className="text-[var(--diff-del-fg)]">−{state.deletions}</span>{' '}
              {t('chat.rewind.dialog.linesSuffix')}
            </div>
          )}

          {/* Error hint */}
          {isError && (
            <div className="mt-3 text-12 leading-[1.5] text-[var(--settings-section-desc)]">
              {t('chat.rewind.dialog.errorHint')}
            </div>
          )}

          {/* Buttons */}
          <div className="mt-5 flex justify-end gap-2.5">
            {!isError ? (
              <>
                <AlertDialog.Cancel asChild>
                  <button
                    type="button"
                    className={cn(
                      'inline-flex items-center justify-center rounded-full px-6 py-2.5 text-14',
                      'border bg-transparent transition-colors',
                      'border-[var(--confirm-btn-secondary-border)] text-[var(--confirm-btn-secondary-text)]',
                      'hover:bg-[var(--confirm-btn-secondary-hover)]',
                    )}
                  >
                    {t('chat.rewind.dialog.cancel')}
                  </button>
                </AlertDialog.Cancel>
                <button
                  type="button"
                  onClick={handleConfirm}
                  disabled={!canConfirm}
                  className={cn(
                    'inline-flex items-center justify-center gap-1.5 rounded-full px-6 py-2.5 text-14 font-medium',
                    'transition-colors',
                    // 主题反色（按设计稿，避开 ConfirmDialog 的 destructive 红）
                    'bg-[var(--send-btn-bg)] text-[var(--send-btn-icon)]',
                    'hover:bg-[var(--confirm-btn-primary-hover)]',
                    'disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:opacity-50',
                  )}
                >
                  {committing ? (
                    <Spinner size={14} strokeWidth={2} />
                  ) : (
                    <Undo2 size={14} strokeWidth={2} />
                  )}
                  {committing
                    ? t(
                        state.kind === 'running'
                          ? 'chat.rewind.dialog.stoppingAndRewinding'
                          : 'chat.rewind.dialog.rewinding',
                      )
                    : t(
                        state.kind === 'running'
                          ? 'chat.rewind.dialog.confirmRunning'
                          : 'chat.rewind.dialog.confirm',
                      )}
                </button>
              </>
            ) : (
              <AlertDialog.Cancel asChild>
                <button
                  type="button"
                  className={cn(
                    'inline-flex items-center justify-center rounded-full px-6 py-2.5 text-14 font-medium',
                    // Error 态：Cancel 升级为黑底主按钮
                    'bg-[var(--send-btn-bg)] text-[var(--send-btn-icon)]',
                    'hover:bg-[var(--confirm-btn-primary-hover)] transition-colors',
                  )}
                >
                  {t('chat.rewind.dialog.acknowledge')}
                </button>
              </AlertDialog.Cancel>
            )}
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

// ─── Body subviews ─────────────────────────────────────────────────────────

function BodyRunning() {
  const { t } = useTranslation();
  return (
    <div
      className={cn(
        'h-[240px] rounded-lg border border-[var(--board)]',
        'flex flex-col items-center justify-center gap-3 px-6 text-center',
        'text-13 text-[var(--cmd-palette-item-meta)]',
      )}
    >
      <Undo2 size={20} strokeWidth={1.5} className="text-[var(--settings-section-desc)]" />
      <div>{t('chat.rewind.dialog.runningNotice')}</div>
      <div className="text-12 text-[var(--settings-section-desc)]">
        {t('chat.rewind.dialog.runningQueueNotice')}
      </div>
    </div>
  );
}

function BodyLoading() {
  const { t } = useTranslation();
  return (
    <div
      className={cn(
        'h-[240px] rounded-lg border border-[var(--board)]',
        'flex flex-col items-center justify-center gap-3',
        'text-13 text-[var(--cmd-palette-item-meta)]',
      )}
    >
      <Spinner size={18} strokeWidth={2} className="text-[var(--status-bar-accent)]" />
      {t('chat.rewind.dialog.calculating')}
    </div>
  );
}

function BodyEmpty({ note }: { note?: string }) {
  const { t } = useTranslation();
  return (
    <div
      className={cn(
        'h-[240px] rounded-lg border border-[var(--board)]',
        'flex flex-col items-center justify-center gap-3 px-6 text-center',
        'text-13 text-[var(--cmd-palette-item-meta)]',
      )}
    >
      <FileText size={20} strokeWidth={1.5} className="text-[var(--settings-section-desc)]" />
      <div>{note ?? t('chat.rewind.dialog.noChanges')}</div>
      {note && (
        <div className="text-12 text-[var(--settings-section-desc)]">
          {t('chat.rewind.dialog.continueWillTruncate')}
        </div>
      )}
    </div>
  );
}

function BodyDefault({ files }: { files: string[] }) {
  const { t } = useTranslation();
  return (
    <div
      className={cn(
        'h-[240px] rounded-lg border border-[var(--board)]',
        'overflow-y-auto',
        'flex flex-col',
      )}
    >
      {files.map((path, idx) => (
        <Tooltip.Root key={`${idx}-${path}`}>
          <Tooltip.Trigger asChild>
            <div
              className={cn(
                'flex items-center gap-2 px-3 py-2.5',
                'cursor-default',
                idx > 0 && 'border-t border-[var(--board)]',
              )}
            >
              <FileTypeIcon name={path}
                size={14}
                className="shrink-0 text-[var(--cmd-palette-item-meta)]"
              />
              <span
                className={cn(
                  'flex-1 truncate font-mono text-13',
                  'text-[var(--settings-back-text)]',
                )}
              >
                {path}
              </span>
            </div>
          </Tooltip.Trigger>
          <Tooltip.Content>{t('chat.rewind.dialog.noPerFileDiff')}</Tooltip.Content>
        </Tooltip.Root>
      ))}
    </div>
  );
}

function BodyError({ errorText }: { errorText: string }) {
  return (
    <div
      className={cn(
        'rounded-lg p-3',
        'bg-[var(--error-bg)]',
        'border border-[var(--error-border)]',
        'flex items-start gap-2.5',
      )}
    >
      <TriangleAlert
        size={16}
        strokeWidth={2}
        className="mt-0.5 shrink-0 text-[var(--error-fg)]"
      />
      <div className="font-mono text-13 leading-[1.5] text-[var(--error-fg-strong)]">
        {errorText}
      </div>
    </div>
  );
}

// ─── helpers ───────────────────────────────────────────────────────────────

function describeSummary(state: DialogState, t: TFunction): string {
  if (state.kind === 'running') {
    return t('chat.rewind.dialog.summaryRunning');
  }
  if (state.kind === 'default') {
    return t('chat.rewind.dialog.summaryDefault', { count: state.filesChanged.length });
  }
  if (state.kind === 'empty') {
    return state.note
      ? t('chat.rewind.dialog.summaryEmptyWithNote')
      : t('chat.rewind.dialog.summaryEmpty');
  }
  return t('chat.rewind.dialog.calculating');
}
