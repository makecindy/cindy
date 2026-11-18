import { useEffect, useRef } from 'react';
import { Ban, CheckCircle2, ChevronDown, ChevronUp, LoaderCircle, XCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { XcodeBuildState } from '../../../../shared/xcodeBuild';
import { cn } from '@/lib/utils';

export function XcodeBuildOutput({
  build,
  output,
  expanded,
  onToggle,
}: {
  build: XcodeBuildState;
  output: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const outputRef = useRef<HTMLPreElement>(null);
  const running = build.status === 'running';

  useEffect(() => {
    if (!expanded || !running) return;
    const element = outputRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [expanded, output, running]);

  const statusLabel =
    build.status === 'running'
      ? t(
          build.phase === 'installing'
            ? 'ccAgent.workdirBrowse.xcode.installing'
            : build.phase === 'launching'
              ? 'ccAgent.workdirBrowse.xcode.launching'
              : build.phase === 'launched'
                ? 'ccAgent.workdirBrowse.xcode.appRunning'
                : build.phase === 'reloading'
                  ? 'ccAgent.workdirBrowse.xcode.reloading'
                  : build.phase === 'restarting'
                    ? 'ccAgent.workdirBrowse.xcode.restarting'
                : 'ccAgent.workdirBrowse.xcode.building',
        )
      : build.status === 'succeeded'
        ? t('ccAgent.workdirBrowse.xcode.succeeded')
        : build.status === 'cancelled'
          ? t('ccAgent.workdirBrowse.xcode.cancelled')
          : t('ccAgent.workdirBrowse.xcode.failed');

  return (
    <section
      aria-label={t('ccAgent.workdirBrowse.xcode.output')}
      className={cn(
        'relative z-10 flex w-full shrink-0 flex-col overflow-hidden border-b border-[var(--cmd-palette-border)] bg-[hsl(var(--content-area))]',
        expanded ? 'h-52' : 'h-8',
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        className="flex h-8 w-full shrink-0 items-center gap-1.5 border-l-2 border-l-[var(--accent-cta-bg-pure)] px-3 text-left text-12 text-[var(--text-primary)] hover:bg-[var(--chat-input-chip-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
        aria-expanded={expanded}
      >
        {build.status === 'running' ? (
          <LoaderCircle size={13} strokeWidth={2} className="animate-spin" />
        ) : build.status === 'succeeded' ? (
          <CheckCircle2 size={13} strokeWidth={2} />
        ) : build.status === 'cancelled' ? (
          <Ban size={13} strokeWidth={2} />
        ) : (
          <XCircle size={13} strokeWidth={2} />
        )}
        <span className="font-medium">{t('ccAgent.workdirBrowse.xcode.output')}</span>
        <span className="text-[var(--text-secondary)]" aria-live="polite">
          {statusLabel}
        </span>
        {build.exitCode !== null && build.status !== 'running' && (
          <span className="font-mono text-11 text-[var(--text-secondary)]">
            {t('ccAgent.workdirBrowse.xcode.exitCode', { code: build.exitCode })}
          </span>
        )}
        <span className="ml-auto flex size-5 items-center justify-center text-[var(--text-secondary)]">
          {expanded ? (
            <ChevronUp size={14} strokeWidth={2} />
          ) : (
            <ChevronDown size={14} strokeWidth={2} />
          )}
        </span>
      </button>
      {expanded && (
        <pre
          ref={outputRef}
          tabIndex={0}
          className="m-0 min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words bg-[hsl(var(--content-area))] px-3 py-2 font-mono text-11 leading-5 text-[var(--text-secondary)]"
        >
          {output || t('ccAgent.workdirBrowse.xcode.waitingForOutput')}
        </pre>
      )}
    </section>
  );
}
