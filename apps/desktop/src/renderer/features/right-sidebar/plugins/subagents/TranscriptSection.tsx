import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  SubagentProvider,
  SubagentTranscriptEntry,
} from '@cindy/maker-shared/subagent-workspace';

import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';

interface TranscriptSectionProps {
  sessionId: string;
  provider: SubagentProvider;
  runId: string;
  supported: boolean;
  workdir: string;
  allowPrivilegedLinks: boolean;
  refreshKey?: number;
}

export function TranscriptSection({
  sessionId,
  provider,
  runId,
  supported,
  workdir,
  allowPrivilegedLinks,
  refreshKey,
}: TranscriptSectionProps) {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<SubagentTranscriptEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [initialLoad, setInitialLoad] = useState(true);
  const requestKey = `${sessionId}:${provider}:${runId}:${refreshKey ?? 0}`;
  const currentRequestKey = useRef(requestKey);
  currentRequestKey.current = requestKey;

  const loadPage = useCallback(
    async (cursor?: string) => {
      const startedFor = requestKey;
      setLoading(true);
      try {
        const response = await window.electronAPI.localDb.subagentRuns.transcript({
          sessionId,
          provider,
          runIdOrAlias: runId,
          ...(cursor ? { cursor } : {}),
        });
        if (!response.supported || currentRequestKey.current !== startedFor) return;
        // Resolvers page forward in time (offset 0 = oldest), so later pages
        // append after what is already rendered to keep chronological order.
        setEntries((prev) => (cursor ? [...prev, ...response.entries] : response.entries));
        setNextCursor(response.nextCursor ?? null);
      } finally {
        if (currentRequestKey.current === startedFor) {
          setLoading(false);
          setInitialLoad(false);
        }
      }
    },
    [provider, requestKey, runId, sessionId],
  );

  useEffect(() => {
    setEntries([]);
    setNextCursor(null);
    setInitialLoad(true);
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

      <div className="space-y-2">
        {entries.map((entry) => (
          <TranscriptEntry
            key={entry.id}
            entry={entry}
            workdir={workdir}
            allowPrivilegedLinks={allowPrivilegedLinks}
          />
        ))}
      </div>

      {nextCursor ? (
        <button
          type="button"
          disabled={loading}
          onClick={() => void loadPage(nextCursor)}
          className="mt-2 flex w-full items-center justify-center rounded-lg border border-[var(--border-default)] px-3 py-1.5 text-11 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] disabled:cursor-wait disabled:opacity-60"
        >
          {loading
            ? t('rightSidebar.subagents.transcriptLoading')
            : t('rightSidebar.subagents.transcriptLoadMore')}
        </button>
      ) : null}
    </section>
  );
}

function TranscriptEntry({
  entry,
  workdir,
  allowPrivilegedLinks,
}: {
  entry: SubagentTranscriptEntry;
  workdir: string;
  allowPrivilegedLinks: boolean;
}) {
  const { t } = useTranslation();

  if (entry.role === 'tool') {
    return (
      <div className="flex min-w-0 items-center gap-2 px-1 py-1 text-11 text-[var(--text-tertiary)]">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--border-strong)]" />
        <span className="shrink-0">{t('rightSidebar.subagents.transcriptRoles.tool')}</span>
        <span className="truncate">{entry.toolName ?? entry.content}</span>
      </div>
    );
  }

  if (entry.role === 'parent') {
    return (
      <div className="ml-7 rounded-xl bg-[var(--surface-user-message)] px-3 py-2.5">
        <span className="mb-0.5 block text-10 font-medium text-[var(--text-tertiary)]">
          {t('rightSidebar.subagents.transcriptRoles.parent')}
        </span>
        <div className="text-12 leading-5 text-[var(--text-primary)]">
          <MarkdownRenderer
            workingDir={workdir}
            content={entry.content}
            allowPrivilegedLinks={allowPrivilegedLinks}
          />
        </div>
      </div>
    );
  }

  // role === 'subagent'
  return (
    <div className="mr-3 px-1 py-2">
      <span className="mb-0.5 block text-10 font-medium text-[var(--text-tertiary)]">
        {t('rightSidebar.subagents.transcriptRoles.subagent')}
      </span>
      <div className="text-13 leading-5 text-[var(--text-primary)]">
        <MarkdownRenderer
          workingDir={workdir}
          content={entry.content}
          allowPrivilegedLinks={allowPrivilegedLinks}
        />
      </div>
    </div>
  );
}
