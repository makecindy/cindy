import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { SubagentTranscriptEntry } from '@cindy/maker-shared/subagent-workspace';

import { cn } from '@/lib/utils';

interface TranscriptSectionProps {
  sessionId: string;
  provider: string;
  runId: string;
  supported: boolean;
}

export function TranscriptSection({ sessionId, provider, runId, supported }: TranscriptSectionProps) {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<SubagentTranscriptEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [initialLoad, setInitialLoad] = useState(true);

  const loadPage = useCallback(
    async (cursor?: string) => {
      setLoading(true);
      try {
        // TODO: Add proper type to electronAPI once IPC is wired up
        const response = await (window.electronAPI as any).localDb.subagentRuns.transcript({
          sessionId,
          provider,
          runIdOrAlias: runId,
          ...(cursor ? { cursor } : {}),
        });
        if (!response.supported) return;
        setEntries((prev) => (cursor ? [...response.entries, ...prev] : response.entries));
        setNextCursor(response.nextCursor ?? null);
      } finally {
        setLoading(false);
        setInitialLoad(false);
      }
    },
    [sessionId, provider, runId],
  );

  useEffect(() => {
    if (supported) void loadPage();
  }, [supported, loadPage]);

  if (!supported) {
    return (
      <p className="mt-5 rounded-lg bg-[var(--surface-subtle)] px-3 py-2 text-11 leading-4 text-[var(--text-tertiary)]">
        {t('rightSidebar.subagents.transcriptUnavailable')}
      </p>
    );
  }

  if (initialLoad && loading) {
    return (
      <p className="mt-5 text-12 text-[var(--text-tertiary)]">
        {t('rightSidebar.subagents.transcriptLoading')}
      </p>
    );
  }

  if (entries.length === 0) {
    return (
      <p className="mt-5 text-12 text-[var(--text-tertiary)]">
        {t('rightSidebar.subagents.transcriptEmpty')}
      </p>
    );
  }

  return (
    <section className="mt-5">
      <h3 className="mb-2 text-11 font-semibold uppercase tracking-[0.06em] text-[var(--text-tertiary)]">
        {t('rightSidebar.subagents.transcript')}
      </h3>

      {nextCursor ? (
        <button
          type="button"
          disabled={loading}
          onClick={() => void loadPage(nextCursor)}
          className="mb-2 flex w-full items-center justify-center rounded-lg border border-[var(--border-default)] px-3 py-1.5 text-11 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] disabled:cursor-wait disabled:opacity-60"
        >
          {loading
            ? t('rightSidebar.subagents.transcriptLoading')
            : t('rightSidebar.subagents.transcriptLoadMore')}
        </button>
      ) : null}

      <div className="space-y-2">
        {entries.map((entry) => (
          <TranscriptEntry key={entry.id} entry={entry} />
        ))}
      </div>
    </section>
  );
}

function TranscriptEntry({ entry }: { entry: SubagentTranscriptEntry }) {
  const { t } = useTranslation();

  if (entry.role === 'system') {
    return (
      <div className="px-2 py-1 text-10 leading-4 text-[var(--text-tertiary)]">
        {entry.content}
      </div>
    );
  }

  if (entry.role === 'tool') {
    return (
      <div className="overflow-hidden rounded-md border border-[var(--border-default)] bg-[var(--surface-subtle)]">
        <div className="flex items-center gap-1.5 border-b border-[var(--border-default)] px-2.5 py-1">
          <span className="text-10 font-medium text-[var(--text-tertiary)]">
            {t('rightSidebar.subagents.transcriptRoles.tool')}
          </span>
          {entry.toolName ? (
            <span className="truncate text-10 text-[var(--text-tertiary)]">
              {entry.toolName}
            </span>
          ) : null}
        </div>
        <pre className="overflow-x-auto whitespace-pre-wrap px-2.5 py-2 font-mono text-11 leading-4 text-[var(--text-secondary)]">
          {entry.content}
        </pre>
      </div>
    );
  }

  if (entry.role === 'parent') {
    return (
      <div className={cn('ml-6 rounded-lg px-3 py-2', 'bg-[var(--surface-user-message)]')}>
        <span className="mb-0.5 block text-10 font-medium text-[var(--text-tertiary)]">
          {t('rightSidebar.subagents.transcriptRoles.parent')}
        </span>
        <p className="whitespace-pre-wrap text-12 leading-5 text-[var(--text-primary)]">
          {entry.content}
        </p>
      </div>
    );
  }

  // role === 'subagent'
  return (
    <div className="mr-6 rounded-lg bg-[var(--surface-subtle)] px-3 py-2">
      <span className="mb-0.5 block text-10 font-medium text-[var(--text-tertiary)]">
        {t('rightSidebar.subagents.transcriptRoles.subagent')}
      </span>
      <p className="whitespace-pre-wrap text-12 leading-5 text-[var(--text-primary)]">
        {entry.content}
      </p>
    </div>
  );
}
