import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { Spinner } from '@/components/ui/spinner';
import type { FileDiff, ReviewMarkdownPreviewData } from '@/lib/gitReview.types';
import { buildMarkdownPreviewPlan } from './markdownBlockDiff';

type MarkdownPreviewState =
  | { status: 'loading' }
  | { status: 'loaded'; data: ReviewMarkdownPreviewData & { content: string } }
  | { status: 'unavailable'; data: ReviewMarkdownPreviewData }
  | { status: 'error'; message: string };

/**
 * 改动段皮肤：全面 Word 修订式 —— 不用背景色块、不用 +/- 符号列，也不做
 * 通栏底色；改动只靠删除线 / 下划线 + diff 语义色表达。
 *
 * 修订色需要穿透 MarkdownRenderer 里自设颜色的组件：blockquote 的
 * `--msg-blockquote-text` 是固定 Near Black（不继承），引用正文会因此
 * 变回黑字；h1-h6 / strong 的 `--md-*-fg` 默认值是 inherit，无需覆盖。
 * 代码块与行内代码保留自己的语法色与底色（可读性优先）。
 */
const CHANGE_TEXT_DECORATION: Record<'added' | 'removed', string> = {
  added:
    'underline decoration-1 underline-offset-2 text-[var(--diff-add-fg)] [&_blockquote]:text-[var(--diff-add-fg)]',
  removed:
    'line-through text-[var(--diff-del-fg)] [&_blockquote]:text-[var(--diff-del-fg)]',
};

/**
 * 渲染富文本预览主体：按 buildMarkdownPreviewPlan 的块级对齐结果分段渲染，
 * 未改片段合并后一次渲染，改动片段各自包一层高亮容器；删除片段按原位置插回，
 * 以旧内容形式可见。降级（blockAligned=false）时只有一个 context 段，
 * DOM 与改造前等价。
 */
function MarkdownPreviewBody({ data }: { data: ReviewMarkdownPreviewData & { content: string } }) {
  const plan = useMemo(
    () => buildMarkdownPreviewPlan(data.content, data.beforeContent ?? null),
    [data.beforeContent, data.content],
  );
  return (
    <>
      {plan.segments.map((segment) => {
        if (segment.kind === 'revision') {
          // 词级修订段：只靠 <ins>/<del> 标记呈现（Word 修订观感），
          // 不再叠加块级背景 / 符号列；标记由 remarkReviewAnnotations 解析。
          return (
            <div key={segment.key} data-review-markdown-change="revision">
              <MarkdownRenderer
                workingDir={data.baseDir ?? ''}
                content={segment.content}
                allowPrivilegedLinks={false}
                reviewAnnotations
              />
            </div>
          );
        }
        if (segment.kind === 'context') {
          return (
            <MarkdownRenderer
              key={segment.key}
              workingDir={data.baseDir ?? ''}
              content={segment.content}
              allowPrivilegedLinks={false}
            />
          );
        }
        return (
          <div
            key={segment.key}
            data-review-markdown-change={segment.kind}
            className={CHANGE_TEXT_DECORATION[segment.kind]}
          >
            <MarkdownRenderer
              workingDir={data.baseDir ?? ''}
              content={segment.content}
              allowPrivilegedLinks={false}
            />
          </div>
        );
      })}
    </>
  );
}

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
    setState((prev) =>
      prev.status === 'loaded' && prev.data.diffId === diff.id ? prev : { status: 'loading' },
    );
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
        if (!cancelled)
          setState({ status: 'error', message: err instanceof Error ? err.message : String(err) });
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
      <MarkdownPreviewBody data={state.data} />
    </div>
  );
}
