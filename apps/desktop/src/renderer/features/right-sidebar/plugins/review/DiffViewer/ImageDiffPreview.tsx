import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { AlertTriangle, Image as ImageIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { Spinner } from '@/components/ui/spinner';
import type { FileDiff, ReviewImagePreviewData, ReviewImagePreviewSide } from '@/lib/gitReview.types';
import { REVIEW_IMAGE_RASTER_MIME_BY_EXT } from '../../../../../../shared/reviewImageExts';

const checkerboardStyle: CSSProperties = {
  backgroundColor: 'var(--surface)',
  backgroundImage: [
    'linear-gradient(45deg, var(--surface-chip) 25%, transparent 25%)',
    'linear-gradient(-45deg, var(--surface-chip) 25%, transparent 25%)',
    'linear-gradient(45deg, transparent 75%, var(--surface-chip) 75%)',
    'linear-gradient(-45deg, transparent 75%, var(--surface-chip) 75%)',
  ].join(', '),
  backgroundPosition: '0 0, 0 8px, 8px -8px, -8px 0',
  backgroundSize: '16px 16px',
};

type ImagePreviewState =
  | { status: 'loading' }
  | { status: 'loaded'; data: ReviewImagePreviewData }
  | { status: 'error'; message: string };

function extensionOf(gitPath: string | null | undefined): string {
  const name = gitPath?.split('/').pop() ?? '';
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot).toLowerCase() : '';
}

export function isPreviewableRasterPath(gitPath: string | null | undefined): boolean {
  // 清单与 main 侧 imageReader 共用 shared/reviewImageExts(SVG 有意排除,见该文件注释)。
  return REVIEW_IMAGE_RASTER_MIME_BY_EXT.has(extensionOf(gitPath));
}

export function isPreviewableImageDiff(diff: Pick<FileDiff, 'kind' | 'path' | 'oldPath'>): boolean {
  return diff.kind !== 'text' && (isPreviewableRasterPath(diff.path) || isPreviewableRasterPath(diff.oldPath));
}

function formatBytes(bytes: number | null | undefined): string | null {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return null;
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb >= 10 ? 0 : 1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(mb >= 10 ? 1 : 2)} MB`;
}

function sideMessage(side: ReviewImagePreviewSide, maxBytes: number, t: (key: string, opts?: Record<string, unknown>) => string): string {
  if (side.tooLarge) {
    return t('rightSidebar.review.imagePreview.tooLarge', {
      size: formatBytes(side.size) ?? '',
      maxSize: formatBytes(maxBytes) ?? '',
    });
  }
  if (!side.present) return side.error ?? t('rightSidebar.review.imagePreview.missing');
  return side.error ?? t('rightSidebar.review.imagePreview.loadFailed');
}

function ImageSidePanel({
  label,
  side,
  maxBytes,
  path,
  muted = false,
  onImageLoad,
}: {
  label: string;
  side: ReviewImagePreviewSide;
  maxBytes: number;
  path: string;
  muted?: boolean;
  onImageLoad?: () => void;
}) {
  const { t } = useTranslation();
  const [dimensions, setDimensions] = useState<string | null>(null);
  const sizeText = formatBytes(side.size);
  const meta = [sizeText, dimensions].filter(Boolean).join(' · ');

  return (
    <div
      className={cn(
        'min-w-0 overflow-hidden rounded-[8px] border border-[var(--border-default)] bg-[var(--surface)]',
        muted && 'opacity-85',
      )}
    >
      <div className="flex h-8 items-center justify-between gap-2 border-b border-[var(--border-default)] px-3 text-11">
        <span className="font-medium text-[var(--text-primary)]">{label}</span>
        {meta && <span className="truncate text-[var(--text-tertiary)]">{meta}</span>}
      </div>
      {side.dataUrl ? (
        <div className="flex min-h-[180px] items-center justify-center p-3" style={checkerboardStyle}>
          <img
            src={side.dataUrl}
            alt={t('rightSidebar.review.imagePreview.alt', { label, path })}
            className="max-h-[420px] max-w-full object-contain"
            onLoad={(event) => {
              const image = event.currentTarget;
              setDimensions(`${image.naturalWidth}×${image.naturalHeight}`);
              onImageLoad?.();
            }}
          />
        </div>
      ) : (
        <div className="flex min-h-[180px] flex-col items-center justify-center gap-2 px-4 py-6 text-center text-12 text-[var(--text-tertiary)]">
          <AlertTriangle size={18} />
          <span>{sideMessage(side, maxBytes, t)}</span>
        </div>
      )}
    </div>
  );
}

export function ImageDiffPreview({
  diff,
  loadImagePreview,
  onImageLoad,
}: {
  diff: FileDiff;
  loadImagePreview: (diff: FileDiff) => Promise<ReviewImagePreviewData>;
  onImageLoad?: () => void;
}) {
  const { t } = useTranslation();
  const [state, setState] = useState<ImagePreviewState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    // 审查数据刷新会换掉 diff 对象引用;同一文件重取时保留已加载内容静默替换,
    // 避免每次刷新都闪一帧 loading(规则 7:获取期间界面不变)。
    setState((prev) => (prev.status === 'loaded' && prev.data.diffId === diff.id ? prev : { status: 'loading' }));
    loadImagePreview(diff)
      .then((data) => {
        if (!cancelled) setState({ status: 'loaded', data });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setState({ status: 'error', message: err instanceof Error ? err.message : String(err) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [diff, loadImagePreview]);

  const panels = useMemo(() => {
    if (state.status !== 'loaded') return [];
    return [
      state.data.old ? {
        key: 'old',
        label: t('rightSidebar.review.imagePreview.old'),
        side: state.data.old,
        path: diff.oldPath ?? diff.path,
        muted: diff.status === 'deleted',
      } : null,
      state.data.new ? {
        key: 'new',
        label: t('rightSidebar.review.imagePreview.new'),
        side: state.data.new,
        path: diff.path,
        muted: false,
      } : null,
    ].filter((panel): panel is {
      key: string;
      label: string;
      side: ReviewImagePreviewSide;
      path: string;
      muted: boolean;
    } => Boolean(panel));
  }, [diff.oldPath, diff.path, diff.status, state, t]);

  if (state.status === 'loading') {
    return (
      <div className="flex min-h-[160px] items-center justify-center gap-2 rounded-[8px] border border-[var(--border-default)] bg-[var(--surface)] text-12 text-[var(--text-tertiary)]">
        <Spinner size={16} />
        <span>{t('rightSidebar.review.imagePreview.loading')}</span>
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="flex min-h-[160px] flex-col items-center justify-center gap-2 rounded-[8px] border border-[var(--border-default)] bg-[var(--surface)] px-4 py-6 text-center text-12 text-[var(--text-tertiary)]">
        <ImageIcon size={18} />
        <span>{t('rightSidebar.review.imagePreview.loadFailed')}</span>
        <span className="max-w-full truncate text-11">{state.message}</span>
      </div>
    );
  }

  if (panels.length === 0) {
    return (
      <div className="flex min-h-[160px] items-center justify-center gap-2 rounded-[8px] border border-[var(--border-default)] bg-[var(--surface)] text-12 text-[var(--text-tertiary)]">
        <ImageIcon size={18} />
        <span>{t('rightSidebar.review.imagePreview.missing')}</span>
      </div>
    );
  }

  return (
    <div
      data-review-image-preview="true"
      className={cn(
        'grid min-w-0 gap-3',
        panels.length > 1 ? 'grid-cols-2' : 'grid-cols-1',
      )}
    >
      {panels.map((panel) => (
        <ImageSidePanel
          key={panel.key}
          label={panel.label}
          side={panel.side}
          maxBytes={state.data.maxBytes}
          path={panel.path}
          muted={panel.muted}
          onImageLoad={onImageLoad}
        />
      ))}
    </div>
  );
}
