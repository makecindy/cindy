import { useCallback, useEffect, useMemo, useState } from 'react';
import * as AlertDialog from '@radix-ui/react-alert-dialog';
import { Archive, MessageSquare, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Schedule, ScheduleRun } from '@cindy/maker-scheduler';

import { cn } from '@/lib/utils';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/lib/toast';
import * as sessionService from '@/lib/sessionService';
import { makerChatStore } from '@/lib/makerChatStore';
import { clearDraft as clearComposerDraft } from '@/lib/composerDraftStore';

const RUNS_PER_DELETE_PREVIEW_LIMIT = 10000;

export type ScheduleGeneratedSessionDisposition = 'keep' | 'archive' | 'delete';

export interface DeleteScheduleTarget {
  id: string;
  name: string;
  source?: 'user' | 'project';
  workingDir?: string;
  projectConfigId?: string;
  knownSessionIds?: readonly string[];
  /**
   * 手绑到该 schedule 的用户既有会话 id(schedule.targetSessionId)。
   *
   * runner 在心跳模式下把 targetSessionId 当每轮 run 的 sessionId 落进
   * schedule_runs(见 scheduler-host/runner.ts),收集"本任务生成的会话"时
   * 必须排除它,否则会被 applyGeneratedSessionDisposition 误软删。
   * 硬不变量:删除 schedule 时绝不能软删/归档一个不是本任务生成的会话。
   *
   * 调用方未传入时,collectGeneratedSessionIds 会自取 schedule 记录兜底解析。
   */
  targetSessionId?: string;
}

export interface DeletedScheduleGeneratedSessionResult {
  target: DeleteScheduleTarget;
  disposition: ScheduleGeneratedSessionDisposition;
  sessionIds: readonly string[];
  affectedSessionIds: readonly string[];
  failedSessionIds: readonly string[];
}

export interface UseDeleteScheduleWithSessionsOptions {
  onDeleted?: (result: DeletedScheduleGeneratedSessionResult) => void | Promise<void>;
}

export function useDeleteScheduleWithSessions(options: UseDeleteScheduleWithSessionsOptions = {}) {
  const { t } = useTranslation();
  const { onDeleted } = options;
  const [target, setTarget] = useState<DeleteScheduleTarget | null>(null);
  const [disposition, setDisposition] = useState<ScheduleGeneratedSessionDisposition>('keep');
  const [loading, setLoading] = useState(false);
  const [sessionCount, setSessionCount] = useState<number | null>(null);
  const [inflightCount, setInflightCount] = useState<number | null>(null);

  const close = useCallback(() => {
    if (loading) return;
    setTarget(null);
  }, [loading]);

  const requestDeleteSchedule = useCallback((schedule: DeleteScheduleTarget) => {
    setDisposition('keep');
    setSessionCount(null);
    setInflightCount(null);
    setTarget(schedule);
  }, []);

  useEffect(() => {
    if (!target) return;
    let cancelled = false;
    void (async () => {
      const [sessionIds, inflight] = await Promise.all([
        collectGeneratedSessionIds(target),
        window.electronAPI.maker.schedule.getInflightCount(target.id).catch(() => 0),
      ]);
      if (cancelled) return;
      setSessionCount(sessionIds.length);
      setInflightCount(inflight);
    })();
    return () => {
      cancelled = true;
    };
  }, [target]);

  const confirmDelete = useCallback(async () => {
    if (!target || loading) return;
    setLoading(true);
    try {
      const sessionIds = await collectGeneratedSessionIds(target);
      await deleteScheduleRecord(target);
      const failedSessionIds = await applyGeneratedSessionDisposition(sessionIds, disposition);
      const failed = new Set(failedSessionIds);
      const affectedSessionIds =
        disposition === 'keep' ? [] : sessionIds.filter((sessionId) => !failed.has(sessionId));
      await onDeleted?.({
        target,
        disposition,
        sessionIds,
        affectedSessionIds,
        failedSessionIds,
      });
      setTarget(null);
      if (failedSessionIds.length > 0) {
        toast.error(
          t('scheduler.deleteDialog.sessionUpdatePartial', {
            ok: sessionIds.length - failedSessionIds.length,
            fail: failedSessionIds.length,
          }),
        );
      } else {
        toast.success(t('scheduler.toast.deleted'));
      }
    } catch (error) {
      toast.error(
        t('scheduler.toast.deleteFailed', {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      setLoading(false);
    }
  }, [disposition, loading, onDeleted, target, t]);

  const dialog = (
    <DeleteScheduleWithSessionsDialog
      open={target !== null}
      target={target}
      disposition={disposition}
      sessionCount={sessionCount}
      inflightCount={inflightCount}
      loading={loading}
      onDispositionChange={setDisposition}
      onConfirm={confirmDelete}
      onCancel={close}
    />
  );

  return { requestDeleteSchedule, deleteScheduleDialog: dialog };
}

async function resolveBoundSessionId(target: DeleteScheduleTarget): Promise<string | undefined> {
  // 调用方已显式传入手绑会话 id 时直接用;否则自取 schedule 记录兜底,
  // 保证手绑的用户既有会话一定从处置集合里排除(硬不变量)。
  if (target.targetSessionId !== undefined) return target.targetSessionId;
  try {
    const list = (await window.electronAPI.maker.schedule.list()) as Schedule[] | undefined;
    return list?.find((s) => s?.id === target.id)?.targetSessionId;
  } catch {
    return undefined;
  }
}

async function collectGeneratedSessionIds(target: DeleteScheduleTarget): Promise<string[]> {
  // 收集层单闸门:两来源(run 历史 ids + knownSessionIds)统一排除手绑的 boundSessionId
  // (schedule.targetSessionId)—— runner 心跳模式把它当每轮 run 的 sessionId 落进
  // schedule_runs,不过滤会误把用户既有会话算进处置集合被软删。与共享 helper、mobile
  // 同一 id 排除机制(共享层是纯工具拿不到 session 对象,亦走 id 排除保底)。
  const boundSessionId = await resolveBoundSessionId(target);
  const ids = new Set<string>();
  const shouldKeep = (id: string | undefined): id is string =>
    !!id && id !== boundSessionId;
  for (const id of target.knownSessionIds ?? []) {
    if (shouldKeep(id)) ids.add(id);
  }
  const runs = (await window.electronAPI.maker.schedule.listRuns(
    target.id,
    RUNS_PER_DELETE_PREVIEW_LIMIT,
  )) as ScheduleRun[];
  for (const run of runs) {
    if (shouldKeep(run.sessionId)) ids.add(run.sessionId);
  }
  return [...ids];
}

async function deleteScheduleRecord(target: DeleteScheduleTarget): Promise<void> {
  if (target.source === 'project' && target.workingDir && target.projectConfigId) {
    await window.electronAPI.maker.projectAutomation.removeSchedule({
      workingDir: target.workingDir,
      id: target.projectConfigId,
    });
    return;
  }
  await window.electronAPI.maker.schedule.delete(target.id);
}

async function applyGeneratedSessionDisposition(
  sessionIds: readonly string[],
  disposition: ScheduleGeneratedSessionDisposition,
): Promise<string[]> {
  if (disposition === 'keep') return [];
  const failed: string[] = [];
  for (const sessionId of sessionIds) {
    try {
      makerChatStore.closeSessionQuery(sessionId);
      if (disposition === 'archive') {
        await sessionService.update(sessionId, { status: 'archived', pinnedAt: null });
      } else {
        await sessionService.update(sessionId, { status: 'deleted' });
        void window.electronAPI.cleanupSessionImages(sessionId).catch(() => undefined);
      }
      makerChatStore.purgeSession(sessionId);
      clearComposerDraft(sessionId);
    } catch {
      failed.push(sessionId);
    }
  }
  return failed;
}

interface DeleteScheduleWithSessionsDialogProps {
  open: boolean;
  target: DeleteScheduleTarget | null;
  disposition: ScheduleGeneratedSessionDisposition;
  sessionCount: number | null;
  inflightCount: number | null;
  loading: boolean;
  onDispositionChange: (value: ScheduleGeneratedSessionDisposition) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

function DeleteScheduleWithSessionsDialog({
  open,
  target,
  disposition,
  sessionCount,
  inflightCount,
  loading,
  onDispositionChange,
  onConfirm,
  onCancel,
}: DeleteScheduleWithSessionsDialogProps) {
  const { t } = useTranslation();
  const options = useMemo(
    () => [
      {
        value: 'keep' as const,
        icon: MessageSquare,
        title: t('scheduler.deleteDialog.option.keep.title'),
        description: t('scheduler.deleteDialog.option.keep.description'),
      },
      {
        value: 'archive' as const,
        icon: Archive,
        title: t('scheduler.deleteDialog.option.archive.title'),
        description: t('scheduler.deleteDialog.option.archive.description'),
      },
      {
        value: 'delete' as const,
        icon: Trash2,
        title: t('scheduler.deleteDialog.option.delete.title'),
        description: t('scheduler.deleteDialog.option.delete.description'),
      },
    ],
    [t],
  );

  return (
    <AlertDialog.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onCancel();
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Overlay
          className={cn(
            'fixed inset-0 z-[10000]',
            'bg-neutral-900/40 dark:bg-neutral-950/60',
            'data-[state=open]:animate-confirm-overlay-in',
            'data-[state=closed]:animate-confirm-overlay-out',
          )}
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        />
        <AlertDialog.Content
          className={cn(
            'fixed left-1/2 top-1/2 z-[10000] -translate-x-1/2 -translate-y-1/2',
            'w-full max-w-[460px] rounded-xl p-4',
            'bg-[var(--confirm-bg)] shadow-[var(--confirm-shadow)]',
            'data-[state=open]:animate-confirm-content-in',
            'data-[state=closed]:animate-confirm-content-out',
          )}
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          onEscapeKeyDown={(event) => {
            if (loading) event.preventDefault();
          }}
        >
          <AlertDialog.Title className="text-lg font-medium text-[var(--confirm-title)]">
            {target
              ? t('scheduler.deleteDialog.title', { name: target.name })
              : t('scheduler.deleteDialog.titleFallback')}
          </AlertDialog.Title>
          <AlertDialog.Description className="mt-2 text-sm leading-relaxed text-[var(--confirm-desc)]">
            {t('scheduler.deleteDialog.description')}
          </AlertDialog.Description>

          <div className="mt-3 rounded-lg border border-[var(--cmd-palette-border)] px-3 py-2 text-xs leading-relaxed text-[var(--cmd-palette-item-meta)]">
            {sessionCount === null
              ? t('scheduler.deleteDialog.sessionCountPending')
              : t('scheduler.deleteDialog.sessionCount', { count: sessionCount })}
            {inflightCount && inflightCount > 0
              ? ` · ${t('scheduler.deleteDialog.inflightCount', { count: inflightCount })}`
              : ''}
          </div>

          <div
            role="radiogroup"
            aria-label={t('scheduler.deleteDialog.optionAria')}
            className="mt-4 flex flex-col gap-2"
          >
            {options.map((option) => {
              const selected = disposition === option.value;
              const Icon = option.icon;
              const destructive = option.value === 'delete';
              return (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  disabled={loading}
                  onClick={() => onDispositionChange(option.value)}
                  className={cn(
                    'flex min-h-[64px] w-full items-start gap-3 rounded-lg border px-3 py-2.5 text-left',
                    'transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)]',
                    selected
                      ? 'border-[var(--settings-source-meta)] bg-[var(--chat-input-chip-bg)]'
                      : 'border-[var(--cmd-palette-border)] bg-transparent hover:bg-[var(--surface-hover)]',
                    loading && 'cursor-default opacity-70',
                  )}
                >
                  <span
                    className={cn(
                      'mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full',
                      'bg-[var(--chat-input-chip-bg)] text-[var(--cmd-palette-item-meta)]',
                      destructive && selected && 'text-[hsl(var(--destructive))]',
                    )}
                  >
                    <Icon size={14} strokeWidth={2} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span
                      className={cn(
                        'block text-sm font-medium text-[var(--msg-assistant-text)]',
                        destructive && selected && 'text-[hsl(var(--destructive))]',
                      )}
                    >
                      {option.title}
                    </span>
                    <span className="mt-0.5 block text-xs leading-relaxed text-[var(--cmd-palette-item-meta)]">
                      {option.description}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>

          <div className="mt-6 flex justify-end gap-2.5">
            <button
              type="button"
              disabled={loading}
              onClick={onConfirm}
              className={cn(
                'inline-flex items-center justify-center rounded-full px-6 py-2.5 text-13 font-medium',
                'transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
                'active:scale-[0.98]',
                'bg-[var(--confirm-btn-primary-bg)] text-[var(--confirm-btn-primary-text)]',
                'hover:bg-[var(--confirm-btn-primary-hover)] focus-visible:ring-[var(--confirm-btn-primary-bg)]',
                loading &&
                  'cursor-default opacity-80 active:scale-100 hover:bg-[var(--confirm-btn-primary-bg)]',
              )}
            >
              {loading ? (
                <Spinner size={14} />
              ) : disposition === 'delete' ? (
                t('scheduler.deleteDialog.confirmDeleteSessions')
              ) : (
                t('scheduler.deleteDialog.confirm')
              )}
            </button>
            <AlertDialog.Cancel asChild>
              <button
                type="button"
                disabled={loading}
                onClick={onCancel}
                className={cn(
                  'inline-flex items-center justify-center rounded-full px-6 py-2.5 text-13 font-medium',
                  'border bg-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
                  'active:scale-[0.98]',
                  'border-[var(--confirm-btn-secondary-border)] text-[var(--confirm-btn-secondary-text)]',
                  'hover:bg-[var(--confirm-btn-secondary-hover)] focus-visible:ring-[var(--confirm-btn-secondary-border)]',
                  loading && 'cursor-default opacity-50 active:scale-100 hover:bg-transparent',
                )}
              >
                {t('scheduler.confirm.delete.cancel')}
              </button>
            </AlertDialog.Cancel>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
