import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { SettingsCard } from '@/components/ui/settings-rows';
import { cn } from '@/lib/utils';
import type { PluginMarketUpdate } from '../../../shared/pluginMarket';
import { PluginDetailSection, usePluginDetailChoice, usePluginDetailRelaxed } from './PluginDetailRecord';
import './plugin-detail-layout.css';

type ReleaseNote = Omit<PluginMarketUpdate, 'publishedAt'> & { publishedAt?: string };

/** Keep the natural line count independent of the current disclosure limit. */
export function usePluginTextLines(text: string) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [lines, setLines] = useState(0);
  useLayoutEffect(() => {
    const paragraph = ref.current;
    if (!paragraph) return;
    const measure = () => {
      const width = paragraph.getBoundingClientRect().width;
      const lineHeight = Number.parseFloat(getComputedStyle(paragraph).lineHeight);
      if (!width || !Number.isFinite(lineHeight)) return;
      const copy = paragraph.cloneNode(true) as HTMLParagraphElement;
      copy.removeAttribute('id');
      copy.setAttribute('aria-hidden', 'true');
      Object.assign(copy.style, {
        display: 'block',
        position: 'fixed',
        left: '-10000px',
        top: '0',
        width: `${width}px`,
        height: 'auto',
        overflow: 'visible',
        visibility: 'hidden',
        WebkitLineClamp: 'unset',
      });
      document.body.appendChild(copy);
      const fullHeight = copy.getBoundingClientRect().height;
      copy.remove();
      setLines(Math.round(fullHeight / lineHeight));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(paragraph);
    return () => observer.disconnect();
  }, [text]);
  return { ref, lines };
}

export function PluginDetailDisclosure({ expanded, controls, onClick, children }: {
  expanded: boolean;
  controls: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Button type="button" variant="secondary" tone="quiet" size="sm" compact
      aria-expanded={expanded} aria-controls={controls} onClick={onClick} className="-ms-3">
      {children}
      <ChevronDown size={14} aria-hidden="true" className={cn(expanded && 'rotate-180')} />
    </Button>
  );
}

export function PluginRecentUpdates({ updates, fallback }: {
  updates?: readonly PluginMarketUpdate[];
  fallback?: ReleaseNote;
}) {
  const latest = updates?.[0] ?? (fallback?.releaseNotes.trim() ? fallback : undefined);
  return latest ? <RecentUpdates latest={latest} older={updates?.slice(1)} /> : null;
}

function RecentUpdates({ latest, older = [] }: {
  latest: ReleaseNote;
  older?: readonly PluginMarketUpdate[];
}) {
  const { t, i18n } = useTranslation();
  const olderId = useId();
  const [showOlder, setShowOlder] = usePluginDetailChoice('olderUpdates');
  const expanded = showOlder ?? false;
  const relaxed = usePluginDetailRelaxed('updates');
  const dateFormat = new Intl.DateTimeFormat(i18n?.language, { month: 'short', day: 'numeric' });
  const hasOlder = older.length > 0;
  const olderLabel = t(expanded ? 'settings.ghosts.detail.collapseOlderUpdates' : 'settings.ghosts.detail.olderUpdates');
  return (
    <PluginDetailSection title={t('settings.ghosts.detail.recentUpdates')}>
      <SettingsCard className="px-4">
        <div className={cn('py-[18px]', hasOlder && 'plugin-recent-updates-timeline')}>
          <div className="plugin-recent-update" data-latest="" data-continues={expanded || undefined}>
            <ReleaseNoteContent note={latest} dateFormat={dateFormat} choiceKey="latestUpdate" latest relaxed={relaxed} />
          </div>
          {hasOlder && (
            <ol id={olderId} hidden={!expanded} className="mt-5 space-y-5">
              {expanded && older.map((note, index) => {
                const key = `${note.version}:${note.publishedAt}:${index}`;
                return (
                  <li key={key} className="plugin-recent-update" data-continues={index < older.length - 1 || undefined}>
                    <ReleaseNoteContent note={note} dateFormat={dateFormat} choiceKey={`olderUpdate:${key}`} />
                  </li>
                );
              })}
            </ol>
          )}
        </div>
        {hasOlder && (
          <button type="button" aria-controls={olderId} aria-expanded={expanded}
            aria-label={expanded ? olderLabel : `${olderLabel} ${older.length}`} onClick={() => setShowOlder(!expanded)}
            className="flex min-h-12 w-full cursor-pointer items-center gap-2 border-t border-[var(--border-default)] py-2 text-start text-13 text-[var(--text-secondary)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]">
            <span className="min-w-0 [overflow-wrap:anywhere]">{olderLabel}</span>
            {!expanded && <span className="tabular-nums text-[var(--text-tertiary)]">{older.length}</span>}
            <ChevronDown size={16} aria-hidden="true" className={cn('ms-auto shrink-0 text-[var(--text-tertiary)]', expanded && 'rotate-180')} />
          </button>
        )}
      </SettingsCard>
    </PluginDetailSection>
  );
}

function ReleaseNoteContent({ note, dateFormat, choiceKey, latest, relaxed }: {
  note: ReleaseNote;
  dateFormat: Intl.DateTimeFormat;
  choiceKey: string;
  latest?: boolean;
  relaxed?: boolean;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [choice, setChoice] = usePluginDetailChoice(choiceKey);
  const { version, publishedAt, releaseNotes: text } = note;
  const { ref, lines } = usePluginTextLines(text);
  const date = publishedAt ? new Date(publishedAt) : null;
  const roomier = choice === undefined && relaxed === true;
  const expand = choice !== true && lines > (roomier ? 10 : 4);
  const collapse = choice === true || (roomier && lines > 4);
  return (
    <>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <span className={cn('min-w-0 text-14 font-medium leading-[1.57] tabular-nums [overflow-wrap:anywhere]',
          latest ? 'text-[var(--text-primary)]' : 'text-[var(--text-secondary)]')}>
          {version.startsWith('v') ? version : `v${version}`}
        </span>
        {date && Number.isFinite(date.getTime()) && (
          <time dateTime={publishedAt} className="ms-auto text-12 tabular-nums text-[var(--text-tertiary)]">
            {dateFormat.format(date)}
          </time>
        )}
      </div>
      <p id={id} ref={ref} className={cn(
        'mt-1 whitespace-pre-wrap [overflow-wrap:anywhere] text-14 leading-[1.7] text-[var(--text-secondary-mid)]',
        choice !== true && (roomier ? 'line-clamp-[10]' : 'line-clamp-4'),
      )}>{text}</p>
      {(expand || collapse) && (
        <div className="mt-0.5">
          <PluginDetailDisclosure expanded={collapse} controls={id} onClick={() => setChoice(!collapse)}>
            {t(collapse ? 'settings.ghosts.detail.descriptionCollapse' : 'settings.ghosts.detail.descriptionExpand')}
          </PluginDetailDisclosure>
        </div>
      )}
    </>
  );
}
