import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Highlighter, X } from 'lucide-react';
import './messageAnnotations.css';
import { Button } from '@/components/ui/button';
import { useMessageAnnotations, updateMessageAnnotations } from '@/lib/messageAnnotationStore';
import type { MessageAnnotation, MessageAnnotationAnchor } from '../../../shared/messageAnnotations';
import { MESSAGE_ANNOTATION_OPEN, resolveAnnotationRange } from './messageAnnotationRange';

type OpenDetail = { sessionId: string; anchor: MessageAnnotationAnchor; point: { x: number; y: number } };
type Badge = { annotation: MessageAnnotation; x: number; y: number };

/** One controller per stream; the native highlighter never mutates React's message DOM. */
export function MessageAnnotations({ sessionId, containerRef }: {
  sessionId: string; containerRef: React.RefObject<HTMLElement | null>;
}) {
  const { t } = useTranslation();
  const annotations = useMessageAnnotations(sessionId);
  const [draft, setDraft] = useState<OpenDetail | null>(null);
  const [selectedRecord, setSelected] = useState<MessageAnnotation | null>(null);
  const selected = annotations.find(annotation => annotation.id === selectedRecord?.id) ?? null;
  const [comment, setComment] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [badges, setBadges] = useState<Badge[]>([]);
  const dialogRef = useRef<HTMLDivElement>(null);
  const saveInFlight = useRef(false);
  const name = `cindy-annotation-${useId().replace(/[^a-z0-9]/gi, '')}`;
  useEffect(() => { setDraft(null); setSelected(null); setComment(''); setError(''); }, [sessionId]);
  useEffect(() => {
    const open = (event: Event) => {
      const detail = (event as CustomEvent<OpenDetail>).detail;
      if (detail.sessionId !== sessionId) return;
      setDraft(detail); setSelected(null); setComment(''); setError('');
      window.getSelection()?.removeAllRanges();
    };
    window.addEventListener(MESSAGE_ANNOTATION_OPEN, open);
    return () => window.removeEventListener(MESSAGE_ANNOTATION_OPEN, open);
  }, [sessionId]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || annotations.length === 0) { setBadges([]); return; }
    let frame = 0;
    const update = () => {
      frame = 0;
      const ranges: Range[] = [], next: Badge[] = [];
      const viewport = container.getBoundingClientRect();
      const roots = new Map(Array.from(container.querySelectorAll<HTMLElement>('[data-annotation-message]'))
        .map(root => [root.dataset.annotationMessage, root]));
      for (const annotation of annotations) {
        const body = roots.get(annotation.messageClientId)?.querySelector<HTMLElement>('[data-selection-quote-body]');
        if (!body) continue;
        const range = resolveAnnotationRange(body, annotation);
        if (!range) continue;
        ranges.push(range);
        const rect = Array.from(range.getClientRects()).at(-1);
        if (rect && rect.bottom >= viewport.top && rect.top <= viewport.bottom) {
          next.push({ annotation, x: Math.min(rect.right - 4, viewport.right - 28), y: Math.max(rect.top - 10, viewport.top) });
        }
      }
      // Electron's Chromium supports the standard CSS Custom Highlight API.
      CSS.highlights.set(name, new Highlight(...ranges));
      setBadges(next);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    const mutations = new MutationObserver(schedule);
    mutations.observe(container, { childList: true, subtree: true, characterData: true });
    const resize = new ResizeObserver(schedule);
    resize.observe(container);
    container.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    schedule();
    return () => {
      cancelAnimationFrame(frame); mutations.disconnect(); resize.disconnect();
      container.removeEventListener('scroll', schedule); window.removeEventListener('resize', schedule);
      CSS.highlights.delete(name);
    };
  }, [annotations, containerRef, name]);

  useEffect(() => {
    if (!draft && !selected) return;
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !saving) { event.preventDefault(); setDraft(null); setSelected(null); }
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [draft, selected, saving]);

  const active = draft?.anchor ?? selected;
  const point = draft?.point ?? badges.find(badge => badge.annotation.id === selected?.id);
  const close = () => { setDraft(null); setSelected(null); setError(''); };
  const save = async () => {
    if (!draft || !comment.trim() || saveInFlight.current) return;
    saveInFlight.current = true;
    setSaving(true); setError('');
    try { await updateMessageAnnotations({ action: 'add', sessionId, anchor: draft.anchor, comment }); close(); }
    catch { setError(t('chat.annotations.saveFailed')); }
    finally { saveInFlight.current = false; setSaving(false); }
  };
  return createPortal(<>
    <style>{`::highlight(${name}) { background-color: color-mix(in srgb, var(--status-info) 26%, transparent); text-decoration: underline; text-decoration-color: color-mix(in srgb, var(--status-info) 65%, transparent); }`}</style>
    {badges.map(({ annotation, x, y }) => <button key={annotation.id} type="button"
      data-chat-copy-exclude="" aria-label={t('chat.annotations.open', { number: annotation.ordinal })}
      title={`${annotation.ordinal}. ${annotation.comment}`} onClick={() => { setSelected(annotation); setDraft(null); setError(''); }}
      className="message-annotation-badge fixed z-20 flex h-5 min-w-5 items-center justify-center rounded-md border px-1 text-[10px] font-semibold shadow-sm focus-visible:outline focus-visible:outline-2"
      style={{ left: x, top: y }}>{annotation.ordinal}</button>)}
    {active && <div ref={dialogRef} role="dialog" aria-label={t('chat.annotations.title')}
      className="fixed z-float-top w-[340px] max-w-[calc(100vw-24px)] rounded-xl border border-border bg-popover p-3 text-popover-foreground shadow-[shadow:var(--shadow-menu)]"
      style={{ left: Math.max(12, Math.min(point?.x ?? 24, window.innerWidth - 352)), top: Math.max(48, Math.min((point?.y ?? 120) + 22, window.innerHeight - 310)) }}>
      <div className="mb-2 flex items-center justify-between gap-2 text-sm font-medium">
        <span className="flex items-center gap-2"><Highlighter className="h-4 w-4 text-[var(--status-info)]" aria-hidden="true" />{t('chat.annotations.title')}{selected ? ` · ${selected.ordinal}` : ''}</span>
        <Button size="sm" variant="secondary" compact disabled={saving} onClick={close} aria-label={t('chat.annotations.close')}><X className="h-4 w-4" /></Button>
      </div>
      <blockquote className="message-annotation-quote mb-3 max-h-20 overflow-auto border-l-2 pl-3 text-xs leading-relaxed text-muted-foreground">{active.quote}</blockquote>
      {draft ? <textarea autoFocus value={comment} onChange={event => setComment(event.target.value)} maxLength={8000}
        onKeyDown={event => {
          if (event.key !== 'Enter' || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
          event.stopPropagation();
          event.preventDefault();
          if (event.altKey) {
            const input = event.currentTarget;
            const start = input.selectionStart, end = input.selectionEnd;
            const next = comment.slice(0, start) + '\n' + comment.slice(end);
            if (next.length <= 8000) {
              setComment(next);
              requestAnimationFrame(() => input.setSelectionRange(start + 1, start + 1));
            }
            return;
          }
          if (!event.repeat) void save();
        }}
        placeholder={t('chat.annotations.placeholder')} aria-label={t('chat.annotations.placeholder')}
        className="min-h-24 w-full resize-y rounded-lg border border-border bg-background p-2 text-sm outline-none focus:ring-1 focus:ring-ring"
        />
        : <p className="max-h-40 overflow-auto whitespace-pre-wrap break-words text-sm leading-relaxed">{selected?.comment}</p>}
      {error && <p role="alert" className="mt-2 text-xs text-destructive">{error}</p>}
      <div className="mt-3 flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">{t(selected?.sentAt ? 'chat.annotations.sent' : selected?.queued ? 'chat.annotations.queued' : 'chat.annotations.pending')}</span>
        {draft ? <Button variant="secondary" className="message-annotation-action" size="sm" disabled={saving || !comment.trim()} onClick={() => void save()}>{t(saving ? 'chat.annotations.saving' : 'chat.annotations.save')} ↵</Button>
          : !selected?.sentAt && !selected?.queued && selected && <Button size="sm" variant="secondary" disabled={saving} onClick={async () => {
            setSaving(true);
            try { await updateMessageAnnotations({ action: 'remove', sessionId, id: selected.id }); close(); }
            catch { setError(t('chat.annotations.saveFailed')); }
            finally { setSaving(false); }
          }}>{t('chat.annotations.remove')}</Button>}
      </div>
    </div>}
  </>, document.body);
}
