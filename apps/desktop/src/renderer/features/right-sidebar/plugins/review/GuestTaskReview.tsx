import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { buildMessageToolResultPairing, describeToolUse, parseMessageToolUse } from '@cindy/maker-shared';
import { isToolResultFailureLike } from '@cindy/maker-shared/message-presentation';
import { DiffView } from '@/components/chat/DiffView';
import { Button } from '@/components/ui/button';
import type { Message } from '@/lib/ccAgent.types';
import { diffSourcesForToolCall } from '@/lib/agent-actions/diffStats';

const PAGE_SIZE = 50;

function RecordedFile({ path, children }: { path: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return <details onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer break-all">{path}</summary>
    {open && children}
  </details>;
}

function recordedChanges(rows: Message[]) {
  const results = buildMessageToolResultPairing(rows).resultByToolUseId;
  return rows.flatMap(row => {
    if (row.role !== 'tool_use') return [];
    const { toolName, input, toolUseId } = parseMessageToolUse(row);
    const result = toolUseId && results.get(toolUseId);
    if (!result) return [];
    const descriptor = describeToolUse(toolName, input);
    if (result.includes('<tool_use_error>') || /\bdeclined\b/i.test(result) || isToolResultFailureLike(descriptor, result)) return [];
    if (descriptor.kind === 'fileChange') {
      return descriptor.changes.map((change, i) => (
        <RecordedFile key={row.id + ':' + i} path={change.movePath ?? change.path}>
          <pre className="overflow-auto text-xs">{change.diff}</pre>
        </RecordedFile>
      ));
    }
    if (descriptor.kind !== 'file' || descriptor.action === 'read') return [];
    const sources = diffSourcesForToolCall(toolName, input);
    if (!sources?.segments.length) return [];
    return [<RecordedFile key={row.id} path={descriptor.filePath}>
      {sources.segments.map(({ key, oldString, newString }) =>
        <DiffView key={key} oldString={oldString} newString={newString} contextLines={3} />)}
    </RecordedFile>];
  });
}

export default function GuestTaskReview({ peer, sessionId }: { peer: string; sessionId: string }) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<Message[]>([]);
  const [request, setRequest] = useState<{ before?: string }>({});
  const [next, setNext] = useState<string>();
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading');
  useEffect(() => {
    let current = true;
    setStatus('loading');
    void window.electronAPI.deviceLink.invoke(peer, 'local-db:messages:list', [
      sessionId, { limit: PAGE_SIZE, ...request },
    ]).then(value => {
      if (!current) return;
      const page = value as Message[];
      if (!Array.isArray(page) || page.some(row => row.sessionId !== sessionId)) throw new Error('Unexpected task history');
      const chronological = [...page].reverse();
      setRows(previous => request.before ? [...chronological, ...previous] : chronological);
      const hasMore = page.length >= PAGE_SIZE || page.some(row => row.agentMeta?.remoteRowsTrimmed === true);
      setNext(hasMore ? page.at(-1)?.id : undefined);
      setStatus('ready');
    }).catch(() => {
      if (!current) return;
      setRows([]);
      setNext(undefined);
      setStatus('failed');
    });
    return () => { current = false; };
  }, [peer, sessionId, request]);
  const changes = useMemo(() => recordedChanges(rows), [rows]);
  return <section className="flex h-full flex-col gap-3 overflow-auto p-3 text-sm">
    <div className="flex items-center justify-between gap-2">
      <h2 className="font-medium">{t('rightSidebar.review.guestTaskTitle')}</h2>
      <Button size="xs" disabled={status === 'loading'} onClick={() => setRequest({})}>{t('rightSidebar.review.refresh')}</Button>
    </div>
    <p className="text-xs text-muted-foreground">{t('rightSidebar.review.guestTaskScope')}</p>
    {status === 'loading' && <p role="status">{t('rightSidebar.review.loadingTitle')}</p>}
    {status === 'failed' && <p role="alert">{t('rightSidebar.review.errorTitle')}</p>}
    {status === 'ready' && !changes.length && <p>{t('rightSidebar.review.turn.emptyTitle')}</p>}
    {changes}
    {next && <Button size="xs" disabled={status === 'loading'} onClick={() => setRequest({ before: next })}>{t('bots.cloud.loadOlder')}</Button>}
  </section>;
}
