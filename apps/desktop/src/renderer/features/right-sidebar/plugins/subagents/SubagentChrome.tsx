/**
 * Small shared chrome for the Subagent panel: status glyph, panel/detail
 * headers, section titles, centered states, the classified error notice and the
 * technical-details rows. All colors go through semantic tokens so both Light
 * and Dark resolve from the theme system (DESIGN.md §10).
 */

import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, ArrowLeft, type LucideIcon } from 'lucide-react';
import type {
  SubagentActivityEntry,
  SubagentRun,
  SubagentTranscriptEntry,
} from '@cindy/maker-shared/subagent-workspace';

import { Spinner } from '@/components/ui/spinner';
import { Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import {
  classifySubagentError,
  formatClockTime,
  statusIcon,
  type SubagentDisplayStatus,
} from './subagentFormat';

/**
 * Status is icon-only by product ruling — no text label next to the glyph. The
 * accessible name carries the state for screen readers and hover.
 */
export function StatusGlyph({
  status,
  label,
}: {
  status: SubagentDisplayStatus;
  label: string;
}) {
  const Icon = statusIcon(status);
  return (
    <Spinner
      icon={Icon}
      size={14}
      spinning={status === 'running'}
      aria-label={label}
      title={label}
      className={cn('text-[var(--text-tertiary)]', status === 'failed' && 'text-[var(--error-fg)]')}
    />
  );
}

/** Panel-level header, matching the sibling right-sidebar panels' 44px bar. */
export function PanelHeader({ icon: Icon, title }: { icon: LucideIcon; title: string }) {
  return (
    <div className="flex h-11 shrink-0 select-none items-center gap-2 border-b border-[var(--border-default)] px-4">
      <Icon size={15} className="text-[var(--text-secondary)]" aria-hidden="true" />
      <h2 className="truncate text-13 font-medium text-[var(--text-primary)]">{title}</h2>
    </div>
  );
}

export function HeaderBack({
  onBack,
  title,
  status,
  action,
}: {
  onBack: () => void;
  title: string;
  status?: SubagentRun['status'];
  action?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex h-11 shrink-0 select-none items-center gap-2 border-b border-[var(--border-default)] px-3">
      <Tip text={t('rightSidebar.subagents.back')} side="bottom">
        <button
          type="button"
          onClick={onBack}
          aria-label={t('rightSidebar.subagents.back')}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
        >
          <ArrowLeft size={15} aria-hidden="true" />
        </button>
      </Tip>
      <span className="min-w-0 flex-1 truncate text-13 font-medium text-[var(--text-primary)]">
        {title}
      </span>
      {action}
      {status ? <StatusGlyph status={status} label={t(`chat.agentTask.status.${status}`)} /> : null}
    </div>
  );
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <h3 className="mb-2 select-none text-11 font-medium uppercase tracking-[0.5px] text-[var(--text-tertiary)]">
      {children}
    </h3>
  );
}

export function CenteredState({
  icon: Icon,
  label,
  detail,
  spinning = false,
  action,
}: {
  icon: LucideIcon;
  label: string;
  detail?: string;
  spinning?: boolean;
  action?: ReactNode;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-8 text-center">
      <Spinner icon={Icon} spinning={spinning} size={20} className="text-[var(--text-tertiary)]" />
      <p className="mt-3 text-13 font-medium text-[var(--text-secondary)]">{label}</p>
      {detail ? (
        <p className="mt-1 text-12 leading-5 text-[var(--text-tertiary)]">{detail}</p>
      ) : null}
      {action}
    </div>
  );
}

/**
 * Classified failure card: an actionable sentence up front, the harness's raw
 * payload kept collapsed (DESIGN.md §11 — say what happened and what to do).
 */
export function SubagentErrorNotice({ rawError }: { rawError: string }) {
  const { t } = useTranslation();
  const kind = classifySubagentError(rawError);
  return (
    <div
      data-subagent-error-kind={kind}
      className="rounded-xl border border-[color-mix(in_srgb,var(--error-fg)_28%,var(--border-default))] bg-[color-mix(in_srgb,var(--error-fg)_7%,var(--surface-elevated))] px-3 py-2.5"
    >
      <div className="flex items-start gap-2 text-13 leading-5 text-[var(--error-fg)]">
        <AlertCircle size={15} className="mt-0.5 shrink-0" aria-hidden="true" />
        <span>{t(`rightSidebar.subagents.errors.${kind}`)}</span>
      </div>
      <details className="mt-2 text-11 text-[var(--text-tertiary)]">
        <summary className="w-fit cursor-pointer rounded-full hover:text-[var(--text-secondary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]">
          {t('rightSidebar.subagents.errors.rawDetails')}
        </summary>
        <pre className="mt-2 max-h-64 select-text overflow-auto whitespace-pre-wrap break-words rounded-lg bg-[var(--msg-code-block-bg)] p-2 font-mono text-11 leading-4 text-[var(--text-secondary)]">
          {rawError}
        </pre>
      </details>
    </div>
  );
}

export function ActivityRow({ entry }: { entry: SubagentActivityEntry }) {
  const { t } = useTranslation();
  const label = t(`rightSidebar.subagents.activityKinds.${entry.kind}`);
  const time = formatClockTime(entry.occurredAt);
  return (
    <div className="relative flex gap-2 pb-3 pl-1 last:pb-0">
      <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-[var(--border-default)]" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="text-12 font-medium text-[var(--text-secondary)]">{label}</span>
          {time ? <span className="shrink-0 text-10 text-[var(--text-tertiary)]">{time}</span> : null}
        </div>
        {entry.summary ? (
          <p className="mt-0.5 whitespace-pre-wrap text-12 leading-4 text-[var(--text-tertiary)]">
            {entry.summary}
          </p>
        ) : null}
        {entry.lastToolName ? (
          <p className="mt-0.5 truncate text-11 text-[var(--text-tertiary)]">
            {t('rightSidebar.subagents.lastTool', { tool: entry.lastToolName })}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Text for a system row.
 *
 * Lines the Host synthesised carry a `systemEvent` slug, and those are shown in
 * the user's language — the durable transcript stores the English sentence once,
 * at synthesis time, and is read back long afterwards by whatever UI locale the
 * user picked. Runtime output (stdout / stderr / harness errors) has no slug and
 * is shown verbatim, as does any record written before the slug existed.
 */
export function useSystemLogText(entry: SubagentTranscriptEntry): string {
  const { t } = useTranslation();
  const kind = entry.systemEvent?.kind;
  if (!kind) return entry.content;
  const key = `rightSidebar.subagents.systemEvents.${kind}`;
  // An unknown slug (newer producer, older renderer bundle) falls back to the
  // English sentence the entry still carries rather than showing a raw key.
  const localized = t(key, { ...(entry.systemEvent?.params ?? {}), defaultValue: '' });
  return localized || entry.content;
}

/** One system line: localized when Cindy wrote it, verbatim when it is output. */
export function SystemLogRow({ entry }: { entry: SubagentTranscriptEntry }) {
  const time = formatClockTime(entry.occurredAt);
  const text = useSystemLogText(entry);
  return (
    <div className="rounded-lg bg-[var(--msg-code-block-bg)] px-2.5 py-2">
      {time ? (
        <div className="mb-1 text-10 leading-4 text-[var(--text-tertiary)]">
          {entry.childTitle ? `${entry.childTitle} · ${time}` : time}
        </div>
      ) : null}
      <p className="select-text whitespace-pre-wrap break-words font-mono text-11 leading-4 text-[var(--text-secondary)]">
        {text}
      </p>
    </div>
  );
}
