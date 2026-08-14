import { useEffect, useState, type ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { Spinner } from '@/components/ui/spinner';
import type { FileDiff, ReviewMarkdownPreviewData } from '@/lib/gitReview.types';

type MarkdownPreviewState =
  | { status: 'loading' }
  | { status: 'loaded'; data: ReviewMarkdownPreviewData & { content: string } }
  | { status: 'unavailable'; data: ReviewMarkdownPreviewData }
  | { status: 'error'; message: string };

function formatBytes(bytes: number | null | undefined): string | null {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return null;
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb >= 10 ? 0 : 1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(mb >= 10 ? 1 : 2)} MB`;
}

function fallbackReasonText(
  data: ReviewMarkdownPreviewData,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  if (data.reason === 'too-large') {
    return t('rightSidebar.review.richPreview.tooLarge', {
      size: formatBytes(data.size) ?? '',
      maxSize: formatBytes(data.maxBytes) ?? '',
    });
  }
  if (data.error) return data.error;
  return t(`rightSidebar.review.richPreview.reason.${data.reason ?? 'read-error'}`, {
    defaultValue: t('rightSidebar.review.richPreview.loadFailed'),
  });
}

function FallbackNotice({
  children,
}: {
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className="mb-2 flex items-start gap-2 rounded-[8px] border border-[var(--border-default)] bg-[var(--surface)] px-3 py-2 text-11 leading-relaxed text-[var(--text-secondary)]">
      <AlertTriangle size={13} className="mt-0.5 shrink-0 text-[var(--text-tertiary)]" />
      <span>
        <span className="font-medium text-[var(--text-primary)]">{t('rightSidebar.review.richPreview.fallbackTitle')}</span>
        <span className="ml-1">{children}</span>
      </span>
    </div>
  );
}

export function MarkdownDiffPreview({
  diff,
  loadMarkdownPreview,
  fallback,
  onPreviewSettled,
}: {
  diff: FileDiff;
  loadMarkdownPreview: (diff: FileDiff) => Promise<ReviewMarkdownPreviewData>;
  fallback: ReactNode;
  onPreviewSettled?: () => void;
}) {
  const { t } = useTranslation();
  const [state, setState] = useState<MarkdownPreviewState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState((prev) => (prev.status === 'loaded' && prev.data.diffId === diff.id ? prev : { status: 'loading' }));
    loadMarkdownPreview(diff)
      .then((data) => {
        if (cancelled) return;
        if (data.content !== null) {
          setState({ status: 'loaded', data: { ...data, content: data.content } });
        } else {
          setState({ status: 'unavailable', data });
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setState({ status: 'error', message: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [diff, loadMarkdownPreview]);

  useEffect(() => {
    if (state.status === 'loading') return;
    const frame = requestAnimationFrame(() => onPreviewSettled?.());
    return () => cancelAnimationFrame(frame);
  }, [onPreviewSettled, state.status]);

  if (state.status === 'loading') {
    return (
      <div className="flex min-h-[160px] items-center justify-center gap-2 rounded-[8px] border border-[var(--border-default)] bg-[var(--surface)] text-12 text-[var(--text-tertiary)]">
        <Spinner size={16} />
        <span>{t('rightSidebar.review.richPreview.loading')}</span>
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <>
        <FallbackNotice>{state.message}</FallbackNotice>
        {fallback}
      </>
    );
  }

  if (state.status === 'unavailable') {
    return (
      <>
        <FallbackNotice>{fallbackReasonText(state.data, t)}</FallbackNotice>
        {fallback}
      </>
    );
  }

  return (
    <div
      data-review-markdown-preview="true"
      className="min-w-0 rounded-[8px] border border-[var(--border-default)] bg-[var(--surface-elevated)] px-4 py-3 text-13 leading-relaxed text-[var(--text-primary)] [&_pre]:max-w-full [&_pre]:overflow-x-auto"
    >
      <MarkdownRenderer
        workingDir={state.data.baseDir ?? ''}
        content={state.data.content}
        allowPrivilegedLinks={false}
      />
    </div>
  );
}
