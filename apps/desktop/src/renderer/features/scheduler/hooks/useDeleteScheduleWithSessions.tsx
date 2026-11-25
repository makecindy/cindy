import { Button } from '@/components/ui/button';
import { useCallback, useEffect, useMemo, useState } from 'react';
import * as AlertDialog from '@radix-ui/react-alert-dialog';
import { Archive, MessageSquare, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Schedule, ScheduleRun } from '@cindy/maker-scheduler';

import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import * as sessionService from '@/lib/sessionService';
import { makerChatStore } from '@/lib/makerChatStore';
import { discardDraft as discardComposerDraft } from '@/lib/composerDraftStore';

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
  /** 批量删除结束后调用一次（无论部分成功与否）。 */
  onBatchFinished?: (deletedIds: readonly string[]) => void | Promise<void>;
}

export function useDeleteScheduleWithSessions(options: UseDeleteScheduleWithSessionsOptions = {}) {
  const { t } = useTranslation();
  const { onDeleted, onBatchFinished } = options;
  const [targets, setTargets] = useState<readonly DeleteScheduleTarget[] | null>(null);
  const [disposition, setDisposition] = useState<ScheduleGeneratedSessionDisposition>('keep');
  const [loading, setLoading] = useState(false);
  const [sessionCount, setSessionCount] = useState<number | null>(null);
  const [inflightCount, setInflightCount] = useState<number | null>(null);

  const close = useCallback(() => {
    if (loading) return;
    setTargets(null);
  }, [loading]);

  const requestDeleteSchedules = useCallback((schedules: readonly DeleteScheduleTarget[]) => {
    if (schedules.length === 0) return;
    setDisposition('keep');
    setSessionCount(null);
    setInflightCount(null);
    setTargets([...schedules]);
  }, []);

  const requestDeleteSchedule = useCallback(
    (schedule: DeleteScheduleTarget) => requestDeleteSchedules([schedule]),
    [requestDeleteSchedules],
  );

  useEffect(() => {
    if (!targets) return;
    let cancelled = false;
    void (async () => {
      const counts = await Promise.all(
        targets.map(async (target) => {
          const [sessionIds, inflight] = await Promise.all([
            collectGeneratedSessionIds(target).catch(() => [] as string[]),
            window.electronAPI.maker.schedule.getInflightCount(target.id).catch(() => 0),
          ]);
          return { sessions: sessionIds.length, inflight };
        }),
      );
      if (cancelled) return;
      setSessionCount(counts.reduce((sum, c) => sum + c.sessions, 0));
      setInflightCount(counts.reduce((sum, c) => sum + c.inflight, 0));
    })();
    return () => {
      cancelled = true;
    };
  }, [targets]);

  const confirmDelete = useCallback(async () => {
    if (!targets || loading) return;
    setLoading(true);
    const deletedIds: string[] = [];
    let sessionOk = 0;
    let sessionFail = 0;
    let firstError: unknown = null;
    let scheduleFail = 0;
    try {
      // 逐个串行删除：每个自动化独立收集/排除手绑会话，单个失败不影响其余。
      for (const target of targets) {
        try {
          const sessionIds = await collectGeneratedSessionIds(target);
          await deleteScheduleRecord(target);
          deletedIds.push(target.id);
          const failedSessionIds = await applyGeneratedSessionDisposition(sessionIds, disposition);
          const failed = new Set(failedSessionIds);
          const affectedSessionIds =
            disposition === 'keep' ? [] : sessionIds.filter((sessionId) => !failed.has(sessionId));
          sessionFail += failedSessionIds.length;
          sessionOk += sessionIds.length - failedSessionIds.length;
          await onDeleted?.({
            target,
            disposition,
            sessionIds,
            affectedSessionIds,
            failedSessionIds,
          });
        } catch (error) {
          scheduleFail += 1;
          firstError ??= error;
        }
      }
      await onBatchFinished?.(deletedIds);
      setTargets(null);
      if (scheduleFail > 0) {
        const message = firstError instanceof Error ? firstError.message : String(firstError);
        toast.error(
          targets.length > 1
            ? t('scheduler.deleteDialog.batchPartial', {
                ok: deletedIds.length,
                fail: scheduleFail,
                error: message,
              })
            : t('scheduler.toast.deleteFailed', { error: message }),
        );
      } else if (sessionFail > 0) {
        toast.error(
          t('scheduler.deleteDialog.sessionUpdatePartial', { ok: sessionOk, fail: sessionFail }),
        );
      } else {
        toast.success(
          targets.length > 1
            ? t('scheduler.toast.batchDeleted', { count: deletedIds.length })
            : t('scheduler.toast.deleted'),
        );
      }
    } finally {
      setLoading(false);
    }
  }, [disposition, loading, onBatchFinished, onDeleted, targets, t]);

  const dialog = (
    <DeleteScheduleWithSessionsDialog
      open={targets !== null}
      targets={targets}
      disposition={disposition}
      sessionCount={sessionCount}
      inflightCount={inflightCount}
      loading={loading}
      onDispositionChange={setDisposition}
      onConfirm={confirmDelete}
      onCancel={close}
    />
  );

  return { requestDeleteSchedule, requestDeleteSchedules, deleteScheduleDialog: dialog };
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
      // 归档可恢复，未发送草稿保留；只有删除才丢弃草稿与附件暂存副本。
      if (disposition === 'delete') discardComposerDraft(sessionId);
    } catch {
      failed.push(sessionId);
    }
  }
  return failed;
}

interface DeleteScheduleWithSessionsDialogProps {
  open: boolean;
  targets: readonly DeleteScheduleTarget[] | null;
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
  targets,
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
            'modal-scrim fixed inset-0 z-modal',
          )}
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        />
        <AlertDialog.Content
          className={cn(
            'modal-panel fixed left-1/2 top-1/2 z-modal -translate-x-1/2 -translate-y-1/2',
            'w-full max-w-[460px] p-4',
          )}
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          onEscapeKeyDown={(event) => {
            if (loading) event.preventDefault();
          }}
        >
          <AlertDialog.Title className="text-lg font-medium text-[var(--confirm-title)]">
            {targets && targets.length > 1
              ? t('scheduler.deleteDialog.batchTitle', { count: targets.length })
              : targets?.[0]
                ? t('scheduler.deleteDialog.title', { name: targets[0].name })
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
            <AlertDialog.Cancel asChild>
              <Button
                variant="secondary"
                size="lg"
                type="button"
                disabled={loading}
                onClick={onCancel}
              >
                {t('scheduler.confirm.delete.cancel')}
              </Button>
            </AlertDialog.Cancel>
            <Button
              variant="cta"
              size="lg"
              loading={loading}
              type="button"
              disabled={loading}
              onClick={onConfirm}
            >
              {disposition === 'delete'
                ? t('scheduler.deleteDialog.confirmDeleteSessions')
                : t('scheduler.deleteDialog.confirm')}
            </Button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
