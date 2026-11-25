import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { gitReviewApiFor } from '@/lib/gitReviewTransport';
import type { FileDiff, ReviewData, ReviewDiffSummaryEntry } from '@/lib/gitReview.types';
import { PlainUnifiedDiff } from './DiffViewer/PlainUnifiedDiff';

type Source = 'staged' | 'unstaged';

function GuestFile({ peer, sessionId, source, file }: {
  peer: string; sessionId: string; source: Source; file: FileDiff | ReviewDiffSummaryEntry;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<FileDiff | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!open || 'hunks' in file) return;
    let current = true;
    setDetail(null);
    setError(false);
    void gitReviewApiFor(peer).fileDiff({ sessionId, source, path: file.path, oldPath: file.oldPath })
      .then(({ diff }) => { if (current) { setDetail(diff); setError(!diff); } })
      .catch(() => { if (current) setError(true); });
    return () => { current = false; };
  }, [file, open, peer, sessionId, source]);
  const diff = 'hunks' in file ? file : detail;
  return <details onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer break-all">{file.path}</summary>
    {open && (diff ? <PlainUnifiedDiff diff={diff} /> :
      <p>{t(error ? 'rightSidebar.review.errorTitle' : 'rightSidebar.review.loadingTitle')}</p>)}
  </details>;
}

export default function GuestTaskReview({ peer, sessionId }: { peer: string; sessionId: string }) {
  const { t } = useTranslation();
  const [data, setData] = useState<ReviewData | null>(null);
  const [revision, setRevision] = useState(0);
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading');
  useEffect(() => {
    let current = true;
    setStatus('loading');
    void gitReviewApiFor(peer).get({ sessionId }).then(result => {
      if (!current) return;
      setData(result);
      setStatus('ready');
    }).catch(() => { if (current) { setData(null); setStatus('failed'); } });
    return () => { current = false; };
  }, [peer, sessionId, revision]);
  return <section className="flex h-full flex-col gap-3 overflow-auto p-3 text-sm">
    <div className="flex items-center justify-between gap-2">
      <h2 className="font-medium">{t('rightSidebar.tabs.kinds.review')}</h2>
      <Button size="xs" disabled={status === 'loading'} onClick={() => setRevision(n => n + 1)}>{t('rightSidebar.review.refresh')}</Button>
    </div>
    {status === 'loading' && <p role="status">{t('rightSidebar.review.loadingTitle')}</p>}
    {status === 'failed' && <p role="alert">{t('rightSidebar.review.errorTitle')}</p>}
    {status === 'ready' && data && (data.scope.disabledReason ?
      <p>{t(`rightSidebar.review.disabled.${data.scope.disabledReason}.title`)}</p> :
      <>
        {!data.summary.dirty && <p>{t('rightSidebar.review.emptyDescGit')}</p>}
        {(['unstaged', 'staged'] as const).map(source => {
          const files = data.diffs.capped?.[source]?.files ?? data.diffs[source];
          return files.length > 0 && <section key={source}>
            <h3 className="font-medium">{t(`rightSidebar.review.source.${source}`)}</h3>
            {files.map(file => <GuestFile key={file.id} {...{ peer, sessionId, source, file }} />)}
          </section>;
        })}
      </>)}
  </section>;
}
