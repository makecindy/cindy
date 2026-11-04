import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import {
  OFFICE_PREVIEW_LIMIT,
  OFFICE_PREVIEW_LIMIT_MB,
  parseOfficeDocument,
  type ParsedOfficeDocument,
} from '@/lib/officePreview';
import { extractIpcError } from '@/utils/ipcError';
import { formatBytes } from './lib/fileMeta';
import { useDelayedFlag } from './hooks/useDelayedFlag';
import './office-preview.css';

interface OfficePreviewProps {
  /** Authorized local file, including a remote resolver's cached copy. */
  filePath: string;
  /** Original name supplies the format even if a cache has renamed its file. */
  formatPath?: string;
  size: number;
  mtimeMs: number;
}

type PreviewState =
  | { kind: 'loading' }
  | { kind: 'ready'; doc: ParsedOfficeDocument }
  | { kind: 'error' }
  | { kind: 'oversize' };

/** Shared read-only Office body for attachments and local/remote file browsing. */
export function OfficePreview(props: OfficePreviewProps) {
  // Version changes remount the reader, so neither old content nor sheet state
  // appears in the first frame of a different file.
  return <OfficeReader key={JSON.stringify(props)} {...props} />;
}

function OfficeReader({ filePath, formatPath, size }: OfficePreviewProps) {
  const { t } = useTranslation();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<PreviewState>({ kind: 'loading' });
  const [sheet, setSheet] = useState(0);
  const showLoading = useDelayedFlag(state.kind === 'loading');

  useEffect(() => {
    let cancelled = false;
    setSheet(0);
    if (size > OFFICE_PREVIEW_LIMIT) {
      setState({ kind: 'oversize' });
      return;
    }
    setState({ kind: 'loading' });
    void parseOfficeDocument(filePath, formatPath).then(
      (doc) => {
        if (!cancelled) setState({ kind: 'ready', doc });
      },
      (error: unknown) => {
        if (!cancelled) {
          // The host checks actual size again; the displayed stat can be stale.
          setState({
            kind: extractIpcError(error)?.code === 'PRECONDITION_FAILED' ? 'oversize' : 'error',
          });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [filePath, formatPath, size, attempt]);

  if (state.kind !== 'ready') {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3 px-6 text-center text-13 text-[var(--text-secondary)]">
        {state.kind === 'loading' ? (
          showLoading ? (
            <Spinner />
          ) : null
        ) : state.kind === 'oversize' ? (
          <p>
            {t('chat.textLightbox.oversizeBody', {
              size: formatBytes(size),
              limit: OFFICE_PREVIEW_LIMIT_MB,
            })}
          </p>
        ) : (
          <>
            <p role="alert">{t('chat.textLightbox.unreadable')}</p>
            <Button variant="secondary" onClick={() => setAttempt((value) => value + 1)}>
              {t('attachmentPreview.retry')}
            </Button>
          </>
        )}
      </div>
    );
  }
  const doc = state.doc;
  const html = doc.kind === 'word' ? doc.html : (doc.sheets[sheet]?.html ?? '');
  return (
    <div className="office-preview flex h-full min-h-0 w-full flex-col text-[var(--text-primary)]">
      {doc.kind === 'sheet' && doc.sheets.length > 1 && (
        <div className="flex shrink-0 gap-2 overflow-x-auto border-b border-[var(--border-default)] px-4 py-2">
          {doc.sheets.map((item, index) => (
            <Button
              key={item.name}
              variant={sheet === index ? 'primary' : 'secondary'}
              aria-pressed={sheet === index}
              className="shrink-0"
              onClick={() => setSheet(index)}
            >
              {item.name}
            </Button>
          ))}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto px-6 py-4 select-text">
        {/* Both parsers return only sanitizeOfficeHtml's reading whitelist. */}
        <div
          className={
            doc.kind === 'word' ? 'office-preview-word mx-auto max-w-4xl' : 'office-preview-sheet'
          }
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>
    </div>
  );
}
