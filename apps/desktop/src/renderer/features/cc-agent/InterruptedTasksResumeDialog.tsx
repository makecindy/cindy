/**
 * 启动时的「继续上次中断的任务」弹窗。
 *
 * 应用意外退出(崩溃 / 强杀 / 退出时仍有任务在跑)后,重启时把所有被中断的任务列出来,
 * 默认全选,用户可以一键继续,也可以去掉不想继续的。
 *
 * 只是每个任务里「继续任务」横幅的批量入口,不引入新的状态:
 *  - 中断判定沿用 sessionActiveTurn 的 startedAt > endedAt,数据由
 *    local-db:sessions:interrupted-resume-candidates 提供(带 bootAt 守卫);
 *  - 「继续」对每个选中任务发与横幅相同的 CONTINUE_AFTER_APP_EXIT_PROMPT,中断标记由
 *    main 在续跑真正派发后确认,红点随 lastTurnEndedAt 广播熄灭;
 *  - 没勾选的任务和「暂不继续」不做任何写入,任务里的横幅与红点照常保留,之后仍可单独处理。
 *
 * 每个窗口生命周期只弹一次;更新说明弹窗打开期间先不弹,关掉后再出现。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useAuth } from '@/contexts/AuthContext';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { VendorIcon, agentKindToVendor } from '@/components/sidebar/VendorIcon';
import type { Session } from '@/lib/ccAgent.types';
import { createLogger } from '@/lib/logger';
import { makerChatStore } from '@/lib/makerChatStore';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { SESSION_READ_BATCH_LIMIT } from '../../../shared/sessionRead';
import { CONTINUE_AFTER_APP_EXIT_PROMPT } from '../../../shared/interruptedTurn';
import { formatSidebarTime } from './lib/formatSidebarTime';
import { getSessionDisplayTitle } from './lib/sessionDisplayTitle';
import { buildSessionSourceLabelMap } from './lib/sessionSourceLabel';

const log = createLogger('interrupted-tasks-resume');

/** localDb 登录后才 ready,首拉沿用 usePendingAlertAttention 的线性退避。 */
const MAX_LOAD_ATTEMPTS = 5;

/**
 * 窗口级单例:布局重挂载不重复查询;弹窗关过一次后本窗口不再弹。
 * 都按数据所有者(账号)隔离:同一窗口换账号登录时,旧账号的任务列表与「已处理」标记不得带入。
 */
let _load: { ownerId: string | null; promise: Promise<InterruptedTask[]> } | null = null;
const _handledOwnerIds = new Set<string | null>();

interface InterruptedTask {
  session: Session;
  interruptedAt: number;
  activity: string | null;
}

async function listStillInterruptedIds(): Promise<Set<string>> {
  const candidates = await window.electronAPI.localDb.sessions.interruptedResumeCandidates();
  return new Set(candidates.map((c) => c.sessionId));
}

async function loadInterruptedTasks(): Promise<InterruptedTask[]> {
  const sessionsApi = window.electronAPI.localDb.sessions;
  const candidates = await sessionsApi.interruptedResumeCandidates();
  if (candidates.length === 0) return [];
  const ids = candidates.map((c) => c.sessionId);
  const batches: Promise<Session[]>[] = [];
  for (let i = 0; i < ids.length; i += SESSION_READ_BATCH_LIMIT) {
    batches.push(sessionsApi.getMany(ids.slice(i, i + SESSION_READ_BATCH_LIMIT)));
  }
  const byId = new Map((await Promise.all(batches)).flat().map((s) => [s.id, s]));
  return candidates
    .flatMap((c) => {
      const session = byId.get(c.sessionId);
      return session ? [{ session, interruptedAt: c.interruptedAt, activity: c.activity }] : [];
    })
    .sort((a, b) => b.interruptedAt - a.interruptedAt);
}

async function loadInterruptedTasksWithRetry(): Promise<InterruptedTask[]> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await loadInterruptedTasks();
    } catch (err) {
      if (attempt >= MAX_LOAD_ATTEMPTS) {
        log.warn('interrupted tasks load gave up:', err);
        return [];
      }
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
    }
  }
}

function TaskCheckbox({
  checked,
  indeterminate = false,
  onChange,
  ariaLabel,
}: {
  checked: boolean;
  indeterminate?: boolean;
  onChange: (checked: boolean) => void;
  ariaLabel?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      aria-label={ariaLabel}
      onChange={(e) => onChange(e.target.checked)}
      className="size-3.5 shrink-0 cursor-pointer accent-[var(--confirm-btn-primary-bg)]"
    />
  );
}

export function InterruptedTasksResumeDialog({ suspended = false }: { suspended?: boolean }) {
  const { t } = useTranslation();
  const { dataOwnerId } = useAuth();
  const [tasks, setTasks] = useState<InterruptedTask[]>([]);
  const [deselected, setDeselected] = useState<ReadonlySet<string>>(() => new Set());
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let active = true;
    if (_load?.ownerId !== dataOwnerId) {
      _load = { ownerId: dataOwnerId, promise: loadInterruptedTasksWithRetry() };
    }
    void _load.promise.then((loaded) => {
      if (!active || _handledOwnerIds.has(dataOwnerId) || loaded.length === 0) return;
      log.info(`found ${loaded.length} interrupted task(s) to offer for resume`);
      setTasks(loaded);
      setOpen(true);
    });
    return () => {
      active = false;
    };
  }, [dataOwnerId]);

  const handleOpenChange = (next: boolean) => {
    if (!next) _handledOwnerIds.add(dataOwnerId);
    setOpen(next);
  };

  const sourceLabels = useMemo(
    () =>
      buildSessionSourceLabelMap(
        tasks.map((task) => task.session),
        [],
        t('ccAgent.sidebar.dialogues'),
        t('settings.cindyMake.title'),
      ),
    [tasks, t],
  );

  const total = tasks.length;
  const selectedIds = tasks.map((task) => task.session.id).filter((id) => !deselected.has(id));
  const selectedCount = selectedIds.length;

  const toggle = (id: string, checked: boolean) => {
    setDeselected((prev) => {
      const next = new Set(prev);
      if (checked) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const toggleAll = (checked: boolean) => {
    setDeselected(checked ? new Set() : new Set(tasks.map((task) => task.session.id)));
  };

  const handleContinue = () => {
    const picked = selectedIds;
    void (async () => {
      // 弹窗可能在更新说明后才出现,期间任务可能已被其它窗口/横幅继续:提交前重新取
      // 仍处于中断态的集合再取交集,避免对已恢复的任务重复续跑。
      const stillInterrupted = await listStillInterruptedIds().catch(() => null);
      if (!stillInterrupted) {
        toast.error(t('chat.interruptedResumeDialog.continueFailed', { count: picked.length }));
        return;
      }
      const ids = picked.filter((id) => stillInterrupted.has(id));
      const results = await Promise.allSettled(
        ids.map((id) => makerChatStore.sendUiTrigger(id, CONTINUE_AFTER_APP_EXIT_PROMPT)),
      );
      const failed = results.filter((r) => r.status === 'rejected');
      if (failed.length === 0) return;
      log.warn(`failed to continue ${failed.length}/${ids.length} interrupted task(s)`);
      toast.error(t('chat.interruptedResumeDialog.continueFailed', { count: failed.length }));
    })();
  };

  if (total === 0) return null;

  const content = (
    <div>
      <div className="flex items-center justify-between px-2 pb-2 text-13">
        <label className="flex cursor-pointer items-center gap-2.5 font-medium text-[var(--confirm-title)]">
          <TaskCheckbox
            checked={selectedCount === total}
            indeterminate={selectedCount > 0 && selectedCount < total}
            onChange={toggleAll}
          />
          {t('chat.interruptedResumeDialog.selectAll')}
        </label>
        <span className="text-12 text-[var(--confirm-desc)]">
          {t('chat.interruptedResumeDialog.selectedCount', { selected: selectedCount, total })}
        </span>
      </div>
      <ul className="border-y border-[var(--border-default)] py-1">
        {tasks.map(({ session, interruptedAt, activity }) => {
          const checked = !deselected.has(session.id);
          const title = getSessionDisplayTitle(session, t('ccAgent.common.unnamedSession'), t);
          const relative = formatSidebarTime(new Date(interruptedAt).toISOString(), t);
          const meta = [
            sourceLabels.get(session.id),
            activity,
            Date.now() - interruptedAt < 60_000
              ? t('chat.interruptedResumeDialog.interruptedJustNow')
              : t('chat.interruptedResumeDialog.interruptedAgo', { time: relative }),
          ].filter(Boolean);
          return (
            <li key={session.id}>
              <label
                className={cn(
                  'flex cursor-pointer items-center gap-2.5 rounded-lg p-2',
                  'hover:bg-[var(--surface-hover)]',
                )}
              >
                <TaskCheckbox
                  checked={checked}
                  ariaLabel={title}
                  onChange={(next) => toggle(session.id, next)}
                />
                <VendorIcon
                  vendor={agentKindToVendor(session.agentKind)}
                  size={14}
                  colorClassName="text-[var(--confirm-desc)]"
                />
                <span className={cn('min-w-0 flex-1', !checked && 'opacity-50')}>
                  <span className="block truncate text-13 text-[var(--confirm-title)]">
                    {title}
                  </span>
                  <span className="mt-0.5 block truncate text-12 text-[var(--confirm-desc)]">
                    {meta.join(' · ')}
                  </span>
                </span>
              </label>
            </li>
          );
        })}
      </ul>
    </div>
  );

  return (
    <ConfirmDialog
      presentation="standard"
      cancelFirst
      autoFocusConfirm
      open={open && !suspended}
      onOpenChange={handleOpenChange}
      maxWidth={460}
      title={t('chat.interruptedResumeDialog.title')}
      description={t('chat.interruptedResumeDialog.description', { count: total })}
      content={content}
      confirmText={
        selectedCount > 0
          ? t('chat.interruptedResumeDialog.continueSelected', { count: selectedCount })
          : t('chat.interruptedResumeDialog.continueNone')
      }
      cancelText={t('chat.interruptedResumeDialog.later')}
      confirmDisabled={selectedCount === 0}
      onConfirm={handleContinue}
    />
  );
}
