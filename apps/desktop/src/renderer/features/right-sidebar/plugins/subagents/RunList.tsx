/**
 * RunList — the Subagent panel's list view.
 *
 * One card per durable run, grouped Running / Finished. A row is a 12px
 * container (DESIGN.md §5) that fills on hover; status is icon-only per the
 * product ruling, so the row's three text lines are title / summary / meta and
 * the corner carries the last-update time.
 */

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Bot } from 'lucide-react';
import type { SubagentRun } from '@cindy/maker-shared/subagent-workspace';

import { PanelHeader, StatusGlyph } from './SubagentChrome';
import { formatRelativeTimestamp, metadata, runTitle } from './subagentFormat';

function RunRow({ run, onOpen }: { run: SubagentRun; onOpen: (run: SubagentRun) => void }) {
  const { t, i18n } = useTranslation();
  const title = runTitle(run, t('rightSidebar.subagents.untitled'));
  const statusLabel = t(`chat.agentTask.status.${run.status}`);
  const meta = metadata(run, t).join(' · ');
  const relative = formatRelativeTimestamp(run.updatedAt, i18n?.language);
  return (
    <button
      type="button"
      onClick={() => onOpen(run)}
      data-subagent-run-row={run.id}
      className="flex w-full items-start gap-2.5 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
    >
      <span className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--surface-chip)]">
        <StatusGlyph status={run.status} label={statusLabel} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-start gap-2">
          <span className="min-w-0 flex-1 truncate text-13 font-medium leading-5 text-[var(--text-primary)]">
            {title}
          </span>
          {relative ? (
            <span className="mt-0.5 shrink-0 select-none text-10 leading-4 text-[var(--text-tertiary)]">
              {relative}
            </span>
          ) : null}
        </span>
        {run.summary ? (
          <span className="mt-0.5 block line-clamp-2 text-12 leading-4 text-[var(--text-secondary)]">
            {run.summary}
          </span>
        ) : null}
        {meta ? (
          <span className="mt-1 block truncate text-11 leading-4 text-[var(--text-tertiary)]">
            {meta}
          </span>
        ) : null}
      </span>
    </button>
  );
}

function GroupTitle({ label }: { label: string }) {
  return (
    <div className="select-none px-3 pb-1 pt-2 text-11 font-medium uppercase tracking-[0.5px] text-[var(--text-tertiary)]">
      {label}
    </div>
  );
}

interface RunListProps {
  runs: readonly SubagentRun[];
  nextCursor: string | null;
  loadingMore: boolean;
  onOpen: (run: SubagentRun) => void;
  onLoadMore: () => void;
}

export function RunList({ runs, nextCursor, loadingMore, onOpen, onLoadMore }: RunListProps) {
  const { t } = useTranslation();
  const grouped = useMemo(
    () => ({
      running: runs.filter((run) => run.status === 'running'),
      finished: runs.filter((run) => run.status !== 'running'),
    }),
    [runs],
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PanelHeader icon={Bot} title={t('rightSidebar.tabs.kinds.subagents')} />
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {grouped.running.length > 0 ? (
          <section>
            <GroupTitle label={t('rightSidebar.subagents.running')} />
            <div className="flex flex-col gap-0.5">
              {grouped.running.map((run) => (
                <RunRow key={run.id} run={run} onOpen={onOpen} />
              ))}
            </div>
          </section>
        ) : null}
        {grouped.finished.length > 0 ? (
          <section className={grouped.running.length > 0 ? 'mt-2' : undefined}>
            <GroupTitle label={t('rightSidebar.subagents.finished')} />
            <div className="flex flex-col gap-0.5">
              {grouped.finished.map((run) => (
                <RunRow key={run.id} run={run} onOpen={onOpen} />
              ))}
            </div>
          </section>
        ) : null}
        {nextCursor ? (
          <button
            type="button"
            disabled={loadingMore}
            onClick={onLoadMore}
            className="mx-3 mt-3 flex h-8 items-center justify-center rounded-full border border-[var(--border-default)] px-3 text-12 text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-hover)] disabled:cursor-wait disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
          >
            {loadingMore
              ? t('rightSidebar.subagents.loading')
              : t('rightSidebar.subagents.loadEarlier')}
          </button>
        ) : null}
      </div>
    </div>
  );
}
