/**
 * PluginBackgroundTasksSection — 插件详情页「后台任务」区块(2026-10)。
 * ---------------------------------------------------------------------------
 * 声明 `agent.hiddenTasks` 的插件可以把自己创建的任务放到后台(不进任务列表、搜索与
 * 通知)。这里是透明性兜底:列出本插件当前在后台的任务,每行可「打开任务」或
 * 「显示到任务列表」(与插件 `cindy.tasks.setHidden` 共用宿主写入口)。
 *
 * - 声明了 hiddenTasks 时总是渲染(空状态说明);其它已安装插件仅在确有后台任务时渲染
 *   (更新移除 hiddenTasks 甚至 tasks 声明后,已在后台的任务仍须可见可接手);
 * - 数据走 Desktop 专用 IPC `ghosts:background-tasks:*`,不进 device-link;
 * - 颜色只用语义 token,Light / Dark 由主题变量自动适配。
 */
import { useCallback, useEffect, useState } from 'react';
import { useInRouterContext, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { RefreshCw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { formatRelative } from '@/hooks/useRelativeTime';
import { sessionsStore } from '@/lib/sessionsStore';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import type { PluginBackgroundTask } from '../../../shared/pluginTasks';

const SECTION_CLASS = 'mt-10';
const HEADING_CLASS = 'text-18 font-medium leading-[1.444] text-[var(--text-primary)]';
const SURFACE_CLASS =
  'border border-[color-mix(in_srgb,var(--border-default)_72%,transparent)] bg-[color-mix(in_srgb,var(--surface-elevated)_82%,var(--surface))]';

export interface PluginBackgroundTasksSectionProps {
  ghostId: string;
  /** 插件已安装(纯市场视图没有本机任务,不发起任何查询)。 */
  installed: boolean;
  /** manifest 同时声明了 agent.hiddenTasks;声明时空列表也渲染空状态。 */
  hiddenTasksDeclared: boolean;
}

export function PluginBackgroundTasksSection(props: PluginBackgroundTasksSectionProps) {
  if (!props.installed) return null;
  return <PluginBackgroundTasksSectionInner {...props} />;
}

function PluginBackgroundTasksSectionInner({ ghostId, hiddenTasksDeclared }: PluginBackgroundTasksSectionProps) {
  const { t } = useTranslation();
  const inRouter = useInRouterContext();
  const [items, setItems] = useState<PluginBackgroundTask[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [revealing, setRevealing] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const result = await window.electronAPI.ghosts.listBackgroundTasks(ghostId);
      setItems(Array.isArray(result?.items) ? result.items : []);
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  }, [ghostId]);

  useEffect(() => {
    void refresh();
    // 插件转入后台 / 显示到任务列表都会广播 hiddenAt patch;据此刷新,不轮询。
    return sessionsStore.subscribePatches((_id, patch) => {
      if (Object.prototype.hasOwnProperty.call(patch, 'hiddenAt')) void refresh();
    });
  }, [refresh]);

  const reveal = async (task: PluginBackgroundTask) => {
    if (revealing) return;
    setRevealing(task.taskId);
    try {
      await window.electronAPI.ghosts.revealBackgroundTask(ghostId, task.taskId);
      toast.success(t('settings.ghosts.backgroundTasks.revealed'));
    } catch {
      toast.error(t('settings.ghosts.backgroundTasks.revealFailed'));
    } finally {
      setRevealing(null);
      void refresh();
    }
  };

  // 未声明 hiddenTasks:没有(或读不到)后台任务时整个区块不出现,不给其它插件多一块空区。
  if (!hiddenTasksDeclared && (items === null || items.length === 0)) return null;

  return (
    <section className={SECTION_CLASS} aria-labelledby="ghost-background-tasks-title">
      <div className="flex min-h-[26px] items-center justify-between gap-4">
        <h2 id="ghost-background-tasks-title" className={HEADING_CLASS}>
          {t('settings.ghosts.backgroundTasks.title')}
        </h2>
        <button
          type="button"
          onClick={() => void refresh()}
          aria-label={t('settings.ghosts.backgroundTasks.refresh')}
          className="shrink-0 rounded-md p-1 text-[var(--text-secondary)] transition-colors duration-150 hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
        >
          <RefreshCw size={14} aria-hidden="true" />
        </button>
      </div>
      <p className="mt-1 max-w-[760px] text-13 leading-5 text-[var(--text-secondary)]">
        {t('settings.ghosts.backgroundTasks.description')}
      </p>
      <div className={cn(SURFACE_CLASS, 'mt-4 max-w-[760px] rounded-xl')}>
        {loadFailed ? (
          <p className="px-5 py-4 text-13 leading-5 text-[var(--warning-fg)]">
            {t('settings.ghosts.backgroundTasks.loadFailed')}
          </p>
        ) : items === null ? (
          <p className="px-5 py-4 text-13 leading-5 text-[var(--text-tertiary)]">
            {t('settings.ghosts.backgroundTasks.loading')}
          </p>
        ) : items.length === 0 ? (
          <p className="px-5 py-4 text-13 leading-5 text-[var(--text-tertiary)]">
            {t('settings.ghosts.backgroundTasks.empty')}
          </p>
        ) : (
          <ul className="divide-y divide-[color-mix(in_srgb,var(--border-default)_72%,transparent)]">
            {items.map((task) => (
              <li
                key={task.taskId}
                data-testid="plugin-background-task"
                className="flex min-h-14 items-center gap-3 px-5 py-3"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-14 font-medium leading-[1.571] text-[var(--text-primary)]">
                    {task.title}
                  </p>
                  <p className="mt-0.5 truncate text-12 leading-[1.5] text-[var(--text-tertiary)]">
                    {t(
                      task.running
                        ? 'settings.ghosts.backgroundTasks.statusRunning'
                        : task.status === 'archived'
                          ? 'settings.ghosts.backgroundTasks.statusArchived'
                          : 'settings.ghosts.backgroundTasks.statusIdle',
                    )}
                    {' · '}
                    {t('settings.ghosts.backgroundTasks.lastActive', {
                      time: formatRelative(task.updatedAt, Date.now(), t),
                    })}
                  </p>
                </div>
                {inRouter ? <OpenTaskButton taskId={task.taskId} /> : null}
                <Button
                  variant="secondary"
                  size="sm"
                  compact
                  type="button"
                  loading={revealing === task.taskId}
                  disabled={revealing !== null && revealing !== task.taskId}
                  onClick={() => void reveal(task)}
                >
                  {t('settings.ghosts.backgroundTasks.reveal')}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

/** 与 /review 审查卡片「打开任务」同一路由;任务不在列表里也能按 id 打开。 */
function OpenTaskButton({ taskId }: { taskId: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <Button
      variant="secondary"
      size="sm"
      compact
      tone="quiet"
      type="button"
      onClick={() => navigate(`/cc-agent/${taskId}`)}
    >
      {t('settings.ghosts.backgroundTasks.open')}
    </Button>
  );
}
