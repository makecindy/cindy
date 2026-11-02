import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

import { WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';

type ExpertDraftRequestView = Awaited<ReturnType<Window['electronAPI']['maker']['experts']['listDrafts']>>[number];

/**
 * Owner approval card for a draft from the expert creator (ROADMAP 3.8, ADR 0005 option A).
 * Shows the exact expert.md that Approve writes and where. Reject can carry a note back to the
 * creator. Nothing is written unless Approve is clicked; the card closes when main settles it
 * (approved, rejected, or timed out).
 */
export function HermesExpertDraftCardView({
  request,
  busy,
  note,
  onNoteChange,
  onDecide,
}: {
  request: ExpertDraftRequestView;
  busy: boolean;
  note: string;
  onNoteChange: (note: string) => void;
  onDecide: (approved: boolean) => void;
}) {
  const { draft } = request;
  return (
    <div
      data-testid="hermes-expert-draft-card"
      role="dialog"
      aria-label="New expert draft"
      className="fixed bottom-6 right-6 z-50 flex max-h-[80vh] w-[min(36rem,calc(100vw-3rem))] flex-col gap-2 rounded-lg border border-[var(--chat-input-border)] bg-[var(--chat-input-bg)] p-4 text-sm text-[var(--chat-input-text)] shadow-xl"
      style={WINDOW_NO_DRAG_STYLE}
    >
      <div className="font-medium">New expert draft: {draft.name}</div>
      <div className="text-xs text-[var(--status-bar-meta)]">{draft.description}</div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
        <dt className="text-[var(--status-bar-meta)]">Writes</dt>
        <dd className="break-all font-mono">{request.targetDir}/expert.md</dd>
        <dt className="text-[var(--status-bar-meta)]">Model</dt>
        <dd>{draft.model ?? 'session model (no route set)'}</dd>
        <dt className="text-[var(--status-bar-meta)]">Memory</dt>
        <dd>{draft.memory ? 'on' : 'off'}</dd>
        {draft.tags.length > 0 && (
          <>
            <dt className="text-[var(--status-bar-meta)]">Tags</dt>
            <dd>{draft.tags.join(', ')}</dd>
          </>
        )}
      </dl>
      <pre
        data-testid="hermes-expert-draft-markdown"
        className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words rounded border border-[var(--perm-code-border)] bg-[var(--perm-code-bg)] p-2 font-mono text-xs"
      >
        {request.markdown}
      </pre>
      <textarea
        aria-label="Note for the expert creator"
        placeholder="Optional: what to change (sent back on Reject)"
        className="h-14 resize-none rounded border border-[var(--chat-input-border)] bg-transparent p-1.5 text-xs"
        value={note}
        disabled={busy}
        onChange={(event) => onNoteChange(event.target.value)}
      />
      <div className="flex justify-end gap-2">
        <button
          type="button"
          data-testid="hermes-expert-draft-reject"
          className="rounded-md border border-[var(--chat-input-border)] px-3 py-1 text-xs"
          disabled={busy}
          onClick={() => onDecide(false)}
        >
          Reject
        </button>
        <button
          type="button"
          data-testid="hermes-expert-draft-approve"
          className="rounded-md bg-[var(--perm-allow-btn-bg)] px-3 py-1 text-xs text-[var(--perm-allow-btn-text,white)]"
          disabled={busy}
          onClick={() => onDecide(true)}
        >
          Approve and save
        </button>
      </div>
    </div>
  );
}

export function HermesExpertDraftCard({ agentKind, sessionId }: { agentKind: string; sessionId: string | null | undefined }) {
  const [request, setRequest] = useState<ExpertDraftRequestView | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setRequest(null);
    setNote('');
    setBusy(false);
    const experts = window.electronAPI?.maker?.experts;
    if (agentKind !== 'hermes' || !sessionId || !experts?.listDrafts) return undefined;
    let alive = true;
    void experts.listDrafts(sessionId)
      .then((list) => { if (alive) setRequest(list[0] ?? null); })
      .catch(() => undefined);
    const off = experts.onDraftEvent((event) => {
      if (event.type === 'request' && event.request.sessionId === sessionId) {
        setRequest(event.request);
        setNote('');
        setBusy(false);
      } else if (event.type === 'settled' && event.sessionId === sessionId) {
        setRequest((current) => (current?.requestId === event.requestId ? null : current));
        setBusy(false);
      }
    });
    return () => {
      alive = false;
      off();
    };
  }, [agentKind, sessionId]);

  if (!request || typeof document === 'undefined') return null;
  return createPortal(
    <HermesExpertDraftCardView
      request={request}
      busy={busy}
      note={note}
      onNoteChange={setNote}
      onDecide={(approved) => {
        setBusy(true);
        void window.electronAPI?.maker?.experts
          .decideDraft(request.requestId, approved ? { approved: true } : { approved: false, note })
          .then((accepted) => { if (!accepted) setRequest(null); })
          .catch(() => setBusy(false));
      }}
    />,
    document.body,
  );
}
