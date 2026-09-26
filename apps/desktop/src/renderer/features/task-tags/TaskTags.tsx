import './taskTags.css';
import { subscribeTaskTagCatalog, readTaskTagCatalog, captureTaskTagScope } from './taskTagEvents';
import { useEffect, useLayoutEffect, useState, useRef } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Check, X, MoreHorizontal, Plus, Pencil, GripVertical, ArrowLeft } from 'lucide-react';
import { Tip } from '@/components/ui/tooltip';
import { useTranslation } from 'react-i18next';
import {
  TASK_TAG_COLORS,
  taskTagNameKey,
  taskTagErrorKey,
  taskTagEditRevision,
  reconcileTaskTags,
  type TaskTag,
  type TaskTagColor,
  type TaskTagRequest,
  type TaskTagResult,
} from '@cindy/maker-shared';
import type { Session } from '@/lib/ccAgent.types';
import { isRemoteSessionWriteBlocked } from '@/features/cc-agent/lib/remoteSessionWriteGuard';
import { isSharedTaskPeer } from '@cindy/device-link';

const buttonBase = 'rounded-full px-3 py-1.5 text-sm disabled:opacity-40';
const button = `${buttonBase} enabled:hover:bg-[var(--surface-hover)]`;
const secondaryButton = `${button} border border-[var(--border-default)]`;
const dangerButton = `${buttonBase} border border-[hsl(var(--destructive))] text-[hsl(var(--destructive))] enabled:hover:bg-[color-mix(in_srgb,hsl(var(--destructive))_10%,transparent)]`;
const primaryButton = `${buttonBase} bg-[var(--accent-cta-bg-pure)] text-[var(--accent-pure-cta-fg)] enabled:hover:bg-[var(--button-cta-hover)] enabled:active:bg-[var(--button-cta-pressed)]`;
const swatch = (tag: TaskTag) => ({
  backgroundColor: `var(--task-tag-${tag.color === 'none' || tag.color === 'white' ? 'white' : tag.color})`,
});
function tagName(tag: TaskTag, t: (key: string) => string) {
  const key = taskTagNameKey(tag);
  return key ? t(key) : tag.name;
}
export function TaskTagDots({ tags = [] }: { tags?: TaskTag[] }) {
  const { t } = useTranslation();
  if (!tags.length) return null;
  return (
    <span
      className="inline-flex shrink-0 items-center pl-1"
      aria-label={tags.map((tag) => tagName(tag, t)).join(', ')}
    >
      {tags.map((tag) => (
        <Tip key={tag.id} text={tagName(tag, t)} delay={0}>
          <span
            aria-label={tagName(tag, t)}
            className="-ml-1 block h-2.5 w-2.5 rounded-full border border-[var(--task-tag-ring-bg,hsl(var(--sidebar)))]"
            style={{
              ...swatch(tag),
              ...(tag.color === 'none' || tag.color === 'white'
                ? { borderColor: 'var(--border-default)' }
                : {}),
            }}
          />
        </Tip>
      ))}
    </span>
  );
}
async function execute(session: Session, request: TaskTagRequest): Promise<TaskTagResult> {
  if (isRemoteSessionWriteBlocked(session)) throw new Error('OFFLINE');
  const scope = captureTaskTagScope(session.deviceLinkDeviceId);
  const result = await (session.deviceLinkDeviceId
    ? ((await window.electronAPI.deviceLink.invoke(
        session.deviceLinkDeviceId,
        'local-db:task-tags:execute',
        [request],
      )) as TaskTagResult)
    : window.electronAPI.localDb.taskTags.execute(request));
  scope.store(result.tags, result.supportedColors);
  const catalog = scope.current() ? readTaskTagCatalog(session.deviceLinkDeviceId) : undefined;
  return catalog
    ? {
        ...result,
        tags: catalog.tags,
        sessions: result.sessions.map(row => ({ ...row, tags: reconcileTaskTags(row.tags, catalog.tags) })),
      }
    : result;
}
export function TaskTagMenuSection({ session, onMore }: { session: Session; onMore: () => void }) {
  const { t } = useTranslation();
  const target = JSON.stringify([session.deviceLinkDeviceId, session.id]);
  const currentTarget = useRef(target);
  currentTarget.current = target;
  const [tags, setTags] = useState<TaskTag[]>(
    () => readTaskTagCatalog(session.deviceLinkDeviceId)?.tags ?? [],
  );
  const [reload, setReload] = useState(0);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const [selected, setSelected] = useState(session.tags ?? []);
  const catalogGeneration = useRef(0);
  const selectionGeneration = useRef(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(
    () =>
      subscribeTaskTagCatalog((deviceId, catalog) => {
        if (deviceId !== session.deviceLinkDeviceId) return;
        catalogGeneration.current++;
        setTags(catalog);
        setSelected((current) => reconcileTaskTags(current, catalog));
      }),
    [session.deviceLinkDeviceId],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const blocked = isSharedTaskPeer(session.deviceLinkDeviceId ?? '') || isRemoteSessionWriteBlocked(session);
  useEffect(() => {
    selectionGeneration.current++;
    setSelected(session.tags ?? []);
  }, [session.tags]);
  useEffect(() => {
    let alive = true;
    const catalogAtStart = catalogGeneration.current;
    const selectionAtStart = selectionGeneration.current;
    const scope = captureTaskTagScope(session.deviceLinkDeviceId);
    setTags(readTaskTagCatalog(session.deviceLinkDeviceId)?.tags ?? []);
    if (blocked) {
      setBusy(false);
      return;
    }
    setError('');
    setBusy(true);
    execute(session, { action: 'get', sessionIds: [session.id] })
      .then((r) => {
        if (!scope.current()) return;
        if (alive && catalogAtStart === catalogGeneration.current) setTags(r.tags);
        if (alive && selectionAtStart === selectionGeneration.current) {
          const row = r.sessions.find((item) => item.sessionId === session.id);
          if (row) setSelected(row.tags);
        }
      })
      .catch((e) => {
        if (alive && scope.current()) setError(taskTagErrorKey(e, 'get'));
      })
      .finally(() => {
        if (alive) setBusy(false);
      });
    return () => {
      alive = false;
    };
  }, [session.id, session.deviceLinkDeviceId, session.deviceLinkConnectionStatus, blocked, reload]);

  const highlightedTag = tags.find((tag) => tag.id === highlightedId);
  return (
    <div
      className="border-t border-[var(--border-default)] px-2 py-2 my-1"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="mb-1 max-w-60 truncate text-xs text-[var(--text-secondary)]">
        {highlightedTag
          ? t(
              selected.some((tag) => tag.id === highlightedTag.id)
                ? 'taskTags.removeLabel'
                : 'taskTags.addLabel',
              {
                name: tagName(highlightedTag, t),
              },
            )
          : t('taskTags.title')}
      </div>
      {error !== 'unavailable' && (
        <div className="flex items-center" role="group" aria-label={t('taskTags.title')}>
          {tags.slice(0, 7).map((tag) => {
            const checked = selected.some((value) => value.id === tag.id);
            const name = tagName(tag, t);
            return (
              <Tip
                key={tag.id}
                text={t(checked ? 'taskTags.removeLabel' : 'taskTags.addLabel', { name })}
                side="bottom"
                delay={150}
              >
                <button
                  type="button"
                  disabled={busy || blocked}
                  aria-label={tagName(tag, t)}
                  aria-pressed={checked}
                  onPointerEnter={() => setHighlightedId(tag.id)}
                  onPointerLeave={() =>
                    setHighlightedId((current) => (current === tag.id ? null : current))
                  }
                  onFocus={() => setHighlightedId(tag.id)}
                  onBlur={() =>
                    setHighlightedId((current) => (current === tag.id ? null : current))
                  }
                  className="group/tag flex h-7 w-6 shrink-0 items-center justify-center rounded-full focus-visible:outline disabled:opacity-40"
                  onClick={async () => {
                    setBusy(true);
                    setError('');
                    const catalogAtStart = catalogGeneration.current;
                    const selectionAtStart = selectionGeneration.current;
                    const scope = captureTaskTagScope(session.deviceLinkDeviceId);
                    try {
                      const r = await execute(session, {
                        action: selected.some((v) => v.id === tag.id) ? 'detach' : 'attach',
                        sessionIds: [session.id],
                        tagIds: [tag.id],
                      });
                      if (!alive.current || !scope.current() || currentTarget.current !== target) return null;
                      if (catalogAtStart === catalogGeneration.current) setTags(r.tags);
                      if (selectionAtStart === selectionGeneration.current)
                        setSelected(r.sessions[0]?.tags ?? []);
                    } catch (e) {
                      if (alive.current && scope.current() && currentTarget.current === target) setError(taskTagErrorKey(e, 'attach'));
                    } finally {
                      if (alive.current && scope.current() && currentTarget.current === target) setBusy(false);
                    }
                  }}
                >
                  <span
                    className={`flex h-4 w-4 items-center justify-center rounded-full border-[0.5px] border-[var(--border-default)] transition-transform duration-[var(--motion-instant)] ease-[var(--motion-ease-move)] motion-reduce:transition-none group-hover/tag:scale-150 group-focus-visible/tag:scale-150 ${tag.color === 'none' || tag.color === 'white' ? 'text-[var(--task-tag-white-check)]' : 'text-[var(--text-primary-on-dark)]'}`}
                    style={swatch(tag)}
                  >
                    {checked ? (
                      highlightedId === tag.id ? (
                        <X size={12} strokeWidth={2.5} aria-hidden />
                      ) : (
                        <Check size={12} strokeWidth={2.5} aria-hidden />
                      )
                    ) : (
                      <Plus
                        size={12}
                        strokeWidth={2.5}
                        aria-hidden
                        className="opacity-0 group-hover/tag:opacity-100 group-focus-visible/tag:opacity-100"
                      />
                    )}
                  </span>
                </button>
              </Tip>
            );
          })}
          <button
            type="button"
            className="group/tag flex h-7 w-6 shrink-0 items-center justify-center rounded-full focus-visible:outline disabled:opacity-40"
            aria-label={t('taskTags.more')}
            title={t('taskTags.more')}
            disabled={
              (blocked && !readTaskTagCatalog(session.deviceLinkDeviceId)) || error === 'unavailable'
            }
            onClick={onMore}
          >
            <span className="flex h-4 w-4 items-center justify-center rounded-full border-[0.5px] border-[var(--border-default)] text-[var(--text-secondary)] transition-transform duration-[var(--motion-instant)] ease-[var(--motion-ease-move)] motion-reduce:transition-none group-hover/tag:scale-150 group-focus-visible/tag:scale-150">
              <MoreHorizontal size={12} aria-hidden />
            </span>
          </button>
        </div>
      )}
      {error && (
        <p className="max-w-64 text-xs text-[var(--text-secondary)]" role="status">
          {t(`taskTags.${error}`)}
          {error === 'loadFailed' && (
            <button
              type="button"
              className={button}
              disabled={busy || blocked}
              onClick={() => setReload((value) => value + 1)}
            >
              {t('taskTags.retry')}
            </button>
          )}
        </p>
      )}
    </div>
  );
}
export function TaskTagEditor({ session, onClose }: { session: Session; onClose: () => void }) {
  const { t } = useTranslation();
  const [tags, setTags] = useState<TaskTag[]>(
    () => readTaskTagCatalog(session.deviceLinkDeviceId)?.tags ?? [],
  );
  const [selected, setSelected] = useState<TaskTag[]>(session.tags ?? []);
  const requestGeneration = useRef(0);
  const selectionGeneration = useRef(0);
  const catalogGeneration = useRef(0);
  const latestCatalog = useRef<TaskTag[]>(tags);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(
    () =>
      subscribeTaskTagCatalog((deviceId, catalog) => {
        if (deviceId !== session.deviceLinkDeviceId) return;
        catalogGeneration.current++;
        latestCatalog.current = catalog;
        setTags(catalog);
        setSelected((current) => reconcileTaskTags(current, catalog));
      }),
    [session.deviceLinkDeviceId],
  );
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const tagListRef = useRef<HTMLDivElement>(null);
  const pointerDrag = useRef<{
    id: string;
    from: number;
    to: number;
    expectedOrder: string[];
    pointerId: number;
    startY: number;
    clientY: number;
    startScroll: number;
    rowHeight: number;
  } | null>(null);
  const dragFrame = useRef<number | null>(null);
  const dropPositions = useRef<Map<string, number> | null>(null);
  const dropAnimations = useRef<Animation[]>([]);
  useLayoutEffect(() => {
    const positions = dropPositions.current;
    if (!positions) return;
    dropPositions.current = null;
    for (const animation of dropAnimations.current) animation.cancel();
    dropAnimations.current = [];
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    // DOM order and drag transforms have changed together. Animate only the
    // remaining visual distance, not the old transform in the new DOM slot.
    for (const row of tagListRef.current?.querySelectorAll<HTMLElement>('[data-tag-row]') ?? []) {
      const previousTop = positions.get(row.dataset.tagRow ?? '');
      if (previousTop === undefined) continue;
      const delta = previousTop - row.getBoundingClientRect().top;
      if (Math.abs(delta) < 0.5) continue;
      const motionStyle = getComputedStyle(row);
      const durationToken = motionStyle.getPropertyValue('--motion-fast').trim();
      const duration = parseFloat(durationToken) * (durationToken.endsWith('ms') ? 1 : 1000);
      dropAnimations.current.push(
        row.animate([{ transform: `translateY(${delta}px)` }, { transform: 'translateY(0px)' }], {
          duration: Number.isFinite(duration) ? duration : 0,
          easing: motionStyle.getPropertyValue('--motion-ease-move').trim() || 'linear',
        }),
      );
    }
  }, [tags, draggedId]);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [dragOffset, setDragOffset] = useState(0);
  function cancelTagDrag() {
    if (dragFrame.current !== null) cancelAnimationFrame(dragFrame.current);
    dragFrame.current = null;
    pointerDrag.current = null;
    setDraggedId(null);
    setDropIndex(null);
    setDragOffset(0);
  }
  useEffect(() => {
    cancelTagDrag();
  }, [tags]);
  useEffect(
    () => () => {
      if (dragFrame.current !== null) cancelAnimationFrame(dragFrame.current);
      for (const animation of dropAnimations.current) animation.cancel();
    },
    [],
  );
  function updateTagDrop(clientY: number, autoScroll = false) {
    const active = pointerDrag.current;
    const list = tagListRef.current;
    if (!active || !list) return;
    active.clientY = clientY;
    const bounds = list.getBoundingClientRect();
    if (autoScroll) {
      if (clientY < bounds.top + 24) list.scrollTop -= 6;
      else if (clientY > bounds.bottom - 24) list.scrollTop += 6;
    }
    const offset = Math.max(
      -active.from * active.rowHeight,
      Math.min(
        (active.expectedOrder.length - 1 - active.from) * active.rowHeight,
        clientY - active.startY + list.scrollTop - active.startScroll,
      ),
    );
    active.to = Math.max(
      0,
      Math.min(
        active.expectedOrder.length - 1,
        active.from + Math.round(offset / active.rowHeight),
      ),
    );
    setDragOffset(offset);
    setDropIndex(active.to);
  }
  function animateTagDrag() {
    const active = pointerDrag.current;
    if (!active) return;
    updateTagDrop(active.clientY, true);
    dragFrame.current = requestAnimationFrame(animateTagDrag);
  }
  function tagRowOffset(index: number) {
    const active = pointerDrag.current;
    if (!active || dropIndex === null) return 0;
    if (index === active.from) return dragOffset;
    if (active.from < dropIndex && index > active.from && index <= dropIndex)
      return -active.rowHeight;
    if (active.from > dropIndex && index >= dropIndex && index < active.from)
      return active.rowHeight;
    return 0;
  }
  const nameInput = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState<TaskTag | null>(null);
  const [name, setName] = useState('');
  const editName = useRef('');
  const [color, setColor] = useState<TaskTagColor>('blue');
  const [formOpen, setFormOpen] = useState(false);
  const [supportedColors, setSupportedColors] = useState<readonly TaskTagColor[]>(
    () =>
      readTaskTagCatalog(session.deviceLinkDeviceId)?.supportedColors ??
      TASK_TAG_COLORS.slice(0, 7),
  );
  const clickTimer = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const [pendingAttach, setPendingAttach] = useState<string | null>(null);
  useEffect(
    () => () => {
      for (const timer of clickTimer.current.values()) clearTimeout(timer);
    },
    [],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [deletion, setDeletion] = useState<TaskTagResult['deletion']>();
  const blocked = isRemoteSessionWriteBlocked(session);
  useEffect(() => {
    if (blocked) cancelTagDrag();
  }, [blocked]);
  useEffect(() => {
    selectionGeneration.current++;
    setSelected(session.tags ?? []);
  }, [session.tags]);
  async function run(request: TaskTagRequest) {
    const scope = captureTaskTagScope(session.deviceLinkDeviceId);
    const generation = ++requestGeneration.current;
    const selectionAtStart = selectionGeneration.current;
    const catalogAtStart = catalogGeneration.current;
    setBusy(true);
    setError('');
    try {
      const r = await execute(session, request);
      if (!alive.current || !scope.current() || generation !== requestGeneration.current) return null;
      if (catalogAtStart === catalogGeneration.current) {
        latestCatalog.current = r.tags;
        setTags(r.tags);
      }
      setSupportedColors(r.supportedColors ?? TASK_TAG_COLORS.slice(0, 7));
      const row = r.sessions.find((s) => s.sessionId === session.id);
      if (row && selectionAtStart === selectionGeneration.current) {
        setSelected(
          catalogAtStart === catalogGeneration.current
            ? row.tags
            : reconcileTaskTags(row.tags, latestCatalog.current),
        );
      }
      return r;
    } catch (e) {
      if (!alive.current || !scope.current() || generation !== requestGeneration.current) return null;
      setError(taskTagErrorKey(e, request.action));
      return null;
    } finally {
      if (alive.current && scope.current() && generation === requestGeneration.current) setBusy(false);
    }
  }
  useEffect(() => {
    const cached = readTaskTagCatalog(session.deviceLinkDeviceId);
    latestCatalog.current = cached?.tags ?? [];
    setTags(cached?.tags ?? []);
    setSupportedColors(cached?.supportedColors ?? TASK_TAG_COLORS.slice(0, 7));
    if (!blocked) void run({ action: 'get', sessionIds: [session.id] });
    else setBusy(false);
    return () => {
      requestGeneration.current++;
    };
  }, [session.id, session.deviceLinkDeviceId, session.deviceLinkConnectionStatus, blocked]);
  function closeEditor() {
    setPendingAttach(null);
    setFormOpen(false);
    setEditing(null);
    setDeletion(undefined);
  }
  function edit(tag: TaskTag | null) {
    if (tag) clearTimeout(clickTimer.current.get(tag.id));
    setFormOpen(true);
    setEditing(tag);
    editName.current = tag ? tagName(tag, t) : '';
    setName(editName.current);
    setColor(tag?.color === 'none' ? 'white' : (tag?.color ?? 'blue'));
    setDeletion(undefined);
    requestAnimationFrame(() => nameInput.current?.focus());
  }
  async function moveTag(id: string, to: number, expectedOrder = tags.map((tag) => tag.id)) {
    if (busy || blocked) return;
    const from = expectedOrder.indexOf(id);
    if (from < 0 || to < 0 || to >= tags.length || from === to) return;
    const tagIds = [...expectedOrder];
    tagIds.splice(from, 1);
    tagIds.splice(to, 0, id);
    const previous = tags;
    setTags(tagIds.map((tagId) => previous.find((tag) => tag.id === tagId)!));
    const result = await run({ action: 'reorder', tagIds, expectedOrder });
    if (!result)
      setTags((current) =>
        current.map((tag) => tag.id).join('\0') === tagIds.join('\0') ? previous : current,
      );
    if (result && editing) setEditing(result.tags.find((tag) => tag.id === editing.id) ?? null);
  }
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[200] bg-[var(--overlay-modal)]" />
        <Dialog.Content
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          onDragStart={(e) => e.stopPropagation()}
          onDragEnd={(e) => e.stopPropagation()}
          onDragOver={(e) => e.stopPropagation()}
          onDrop={(e) => e.stopPropagation()}
          className={`fixed left-1/2 top-1/2 z-[201] w-[min(380px,calc(100vw-32px))] max-h-[85dvh] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-4 text-[var(--text-primary)] shadow-xl ${formOpen ? 'overflow-auto' : 'flex flex-col overflow-hidden'}`}
        >
          <div className="flex shrink-0 items-center gap-2">
            {formOpen && !deletion && (
              <button
                className={button}
                aria-label={t('taskTags.back')}
                disabled={busy}
                onClick={closeEditor}
              >
                <ArrowLeft size={16} />
              </button>
            )}
            <Dialog.Title className="flex-1 text-base font-semibold">
              {t(
                deletion
                  ? 'taskTags.delete'
                  : formOpen
                    ? editing
                      ? 'taskTags.editTitle'
                      : 'taskTags.add'
                    : 'taskTags.title',
              )}
            </Dialog.Title>
            {!formOpen && (
              <span className="text-xs text-[var(--text-secondary)]">
                {t('taskTags.selectedCount', { count: selected.length })}
              </span>
            )}
          </div>
          <Dialog.Description className="sr-only">{session.title}</Dialog.Description>
          {!formOpen && (
            <div
              ref={tagListRef}
              className="task-tag-list-scroll my-3 min-h-0 max-h-[528px] overflow-x-hidden overflow-y-auto overscroll-contain"
            >
              {tags.map((tag, index) => (
                <div
                  key={tag.id}
                  data-tag-row={tag.id}
                  style={{
                    transform: `translateY(${tagRowOffset(index)}px)`,
                    zIndex: draggedId === tag.id ? 1 : undefined,
                  }}
                  className={`relative group/tagrow flex items-center gap-2 min-h-11 rounded-lg ${draggedId === tag.id ? 'bg-[var(--surface-hover)] outline outline-1 outline-[var(--border-default)] cursor-grabbing' : `hover:bg-[var(--surface-hover)] ${dropPositions.current ? '' : 'transition-transform duration-[var(--motion-fast)] ease-[var(--motion-ease-move)] motion-reduce:transition-none'}`}`}
                >
                  <button
                    type="button"
                    className="flex h-7 w-7 shrink-0 cursor-grab items-center justify-center text-[var(--text-secondary)] opacity-0 group-hover/tagrow:opacity-60 group-focus-within/tagrow:opacity-60 [@media(pointer:coarse)]:opacity-60"
                    style={{
                      touchAction: 'none',
                      userSelect: 'none',
                      cursor: draggedId === tag.id ? 'grabbing' : 'grab',
                      opacity: draggedId === tag.id ? 1 : undefined,
                    }}
                    onPointerDown={(event) => {
                      if (event.button !== 0 || busy || blocked) return;
                      event.preventDefault();
                      event.stopPropagation();
                      for (const animation of dropAnimations.current) animation.cancel();
                      dropAnimations.current = [];
                      event.currentTarget.setPointerCapture(event.pointerId);
                      const row = event.currentTarget.closest<HTMLElement>('[data-tag-row]');
                      pointerDrag.current = {
                        id: tag.id,
                        from: index,
                        to: index,
                        expectedOrder: tags.map((item) => item.id),
                        pointerId: event.pointerId,
                        startY: event.clientY,
                        clientY: event.clientY,
                        startScroll: tagListRef.current?.scrollTop ?? 0,
                        rowHeight: row?.getBoundingClientRect().height || 44,
                      };
                      setDragOffset(0);
                      dragFrame.current = requestAnimationFrame(animateTagDrag);
                      setDraggedId(tag.id);
                      setDropIndex(index);
                    }}
                    onPointerMove={(event) => {
                      if (pointerDrag.current?.pointerId !== event.pointerId) return;
                      event.stopPropagation();
                      updateTagDrop(event.clientY);
                    }}
                    onPointerUp={(event) => {
                      if (pointerDrag.current?.pointerId !== event.pointerId) return;
                      event.stopPropagation();
                      updateTagDrop(event.clientY);
                      const active = pointerDrag.current;
                      dropPositions.current = new Map(
                        Array.from(
                          tagListRef.current?.querySelectorAll<HTMLElement>('[data-tag-row]') ?? [],
                        ).map(
                          (row) => [row.dataset.tagRow!, row.getBoundingClientRect().top] as const,
                        ),
                      );
                      cancelTagDrag();
                      if (event.currentTarget.hasPointerCapture(event.pointerId))
                        event.currentTarget.releasePointerCapture(event.pointerId);
                      if (active) void moveTag(active.id, active.to, active.expectedOrder);
                    }}
                    onPointerCancel={cancelTagDrag}
                    onLostPointerCapture={cancelTagDrag}
                    onDragStart={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                    }}
                    aria-label={t('taskTags.reorderLabel', { name: tagName(tag, t) })}
                    title={t('taskTags.reorderHint')}
                    disabled={busy || blocked}
                    onKeyDown={(event) => {
                      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                        event.preventDefault();
                        void moveTag(tag.id, index + (event.key === 'ArrowUp' ? -1 : 1));
                      }
                    }}
                  >
                    <GripVertical size={14} />
                  </button>
                  <button
                    type="button"
                    disabled={busy || blocked}
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full"
                    aria-label={t(
                      selected.some((item) => item.id === tag.id)
                        ? 'taskTags.removeLabel'
                        : 'taskTags.addLabel',
                      { name: tagName(tag, t) },
                    )}
                    aria-pressed={selected.some((item) => item.id === tag.id)}
                    onClick={() =>
                      void run({
                        action: selected.some((item) => item.id === tag.id) ? 'detach' : 'attach',
                        sessionIds: [session.id],
                        tagIds: [tag.id],
                      })
                    }
                  >
                    <span
                      className={`flex h-4 w-4 items-center justify-center rounded-full border-[0.5px] border-[var(--border-default)] ${tag.color === 'none' || tag.color === 'white' ? 'text-[var(--task-tag-white-check)]' : 'text-[var(--text-primary-on-dark)]'}`}
                      style={swatch(tag)}
                    >
                      {selected.some((item) => item.id === tag.id) && (
                        <Check size={12} strokeWidth={2.5} />
                      )}
                    </span>
                  </button>
                  <button
                    type="button"
                    disabled={busy || blocked}
                    className="min-w-0 flex-1 truncate py-1.5 text-left text-sm"
                    title={tagName(tag, t)}
                    onDoubleClick={() => edit(tag)}
                    onClick={(event) => {
                      clearTimeout(clickTimer.current.get(tag.id));
                      const toggle = () =>
                        void run({
                          action: selected.some((item) => item.id === tag.id) ? 'detach' : 'attach',
                          sessionIds: [session.id],
                          tagIds: [tag.id],
                        });
                      if (event.detail === 0) toggle();
                      else if (event.detail === 1)
                        clickTimer.current.set(tag.id, setTimeout(toggle, 300));
                    }}
                  >
                    {tagName(tag, t)}
                  </button>
                  <button
                    type="button"
                    disabled={busy || blocked}
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full opacity-0 group-hover/tagrow:opacity-100 group-focus-within/tagrow:opacity-100 [@media(pointer:coarse)]:opacity-100"
                    aria-label={t('taskTags.editLabel', { name: tagName(tag, t) })}
                    onClick={() => edit(tag)}
                  >
                    <Pencil size={14} />
                  </button>
                </div>
              ))}
              {!tags.length && !error && !blocked && (
                <p className="py-8 text-center text-sm text-[var(--text-secondary)]" role="status">
                  {t(busy ? 'taskTags.loading' : 'taskTags.empty')}
                </p>
              )}
            </div>
          )}
          {!formOpen && (
            <div className="shrink-0 border-t border-[var(--border-default)] pt-2">
              <button
                className={`${button} flex w-full items-center gap-3`}
                disabled={busy || blocked}
                onClick={() => edit(null)}
              >
                <Plus size={16} />
                {t('taskTags.add')}
              </button>
            </div>
          )}
          {formOpen && !deletion && (
            <form
              className="space-y-4 pt-4"
              onSubmit={async (e) => {
                e.preventDefault();
                if (pendingAttach) {
                  const attached = await run({
                    action: 'attach',
                    sessionIds: [session.id],
                    tagIds: [pendingAttach],
                  });
                  if (attached) closeEditor();
                  return;
                }
                const r = await run(
                  editing
                    ? {
                        action: 'update',
                        tagId: editing.id,
                        revision: taskTagEditRevision(editing, latestCatalog.current),
                        name: name === editName.current ? undefined : name,
                        nameCustomized: name === editName.current ? undefined : true,
                        color:
                          editing.color === 'none' &&
                          color === 'white' &&
                          !supportedColors.includes('white')
                            ? undefined
                            : color,
                      }
                    : { action: 'create', name, color },
                );
                if (r) {
                  const created = !editing
                    ? r.tags.find((tag) => tag.name === name.trim())
                    : r.tags.find((tag) => tag.id === pendingAttach);
                  if (created) {
                    setEditing(created);
                    setPendingAttach(created.id);
                    const attached = await run({
                      action: 'attach',
                      sessionIds: [session.id],
                      tagIds: [created.id],
                    });
                    if (!attached) return;
                  }
                  closeEditor();
                }
              }}
            >
              <label className="block text-sm">
                {t('taskTags.name')}
                <input
                  ref={nameInput}
                  className="mt-2 block w-full rounded-lg border border-[var(--border-default)] bg-[var(--surface)] px-3 py-2"
                  value={name}
                  maxLength={80}
                  disabled={busy || blocked || Boolean(pendingAttach)}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <div>
                <p className="text-sm text-[var(--text-secondary)]">{t('taskTags.color')}</p>
                <div className="grid grid-cols-6 gap-y-2 py-2">
                  {TASK_TAG_COLORS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      aria-label={t(`taskTags.${c}`)}
                      aria-pressed={color === c}
                      title={t(
                        supportedColors.includes(c) ? `taskTags.${c}` : 'taskTags.unavailable',
                      )}
                      disabled={
                        busy || blocked || Boolean(pendingAttach) || !supportedColors.includes(c)
                      }
                      onClick={() => setColor(c)}
                      className="flex h-11 items-center justify-center rounded-full hover:bg-[var(--surface-hover)] disabled:opacity-30"
                    >
                      <span
                        className={`flex h-6 w-6 items-center justify-center rounded-full border-[0.5px] border-[var(--border-default)] ${c === 'white' ? 'text-[var(--task-tag-white-check)]' : 'text-[var(--text-primary-on-dark)]'}`}
                        style={swatch({ color: c } as TaskTag)}
                      >
                        {color === c && <Check size={14} />}
                      </span>
                    </button>
                  ))}
                </div>
                <p className="text-xs text-[var(--text-secondary)]">
                  {t(
                    supportedColors.length < TASK_TAG_COLORS.length
                      ? 'taskTags.unavailable'
                      : editing
                        ? 'taskTags.editHint'
                        : 'taskTags.addHint',
                  )}
                </p>
              </div>
              <div className="flex flex-wrap justify-end gap-2 pt-2">
                <button
                  className={`${primaryButton} order-3`}
                  disabled={
                    busy ||
                    blocked ||
                    !name.trim() ||
                    (!supportedColors.includes(color) &&
                      !(editing?.color === 'none' && color === 'white'))
                  }
                  type="submit"
                >
                  {t(editing ? 'taskTags.save' : 'taskTags.create')}
                </button>
                <button
                  className={secondaryButton}
                  type="button"
                  disabled={busy}
                  onClick={closeEditor}
                >
                  {t('taskTags.cancel')}
                </button>
                {editing && (
                  <>
                    <button
                      className={`${button} mr-auto order-first text-[var(--text-secondary)]`}
                      type="button"
                      disabled={busy || blocked}
                      onClick={async () => {
                        const r = await run({ action: 'previewDelete', tagId: editing.id });
                        if (r) setDeletion(r.deletion);
                      }}
                    >
                      {t('taskTags.delete')}
                    </button>
                  </>
                )}
              </div>
            </form>
          )}
          {deletion && (
            <div className="space-y-5 pt-3">
              <p className="break-words text-sm leading-6 text-[var(--text-secondary)]">
                {t('taskTags.deleteConfirm', {
                  name: editing ? tagName(editing, t) : '',
                  count: deletion.count,
                })}
              </p>
              <div className="flex flex-wrap justify-end gap-2">
                <button
                  autoFocus
                  className={secondaryButton}
                  disabled={busy}
                  onClick={() => setDeletion(undefined)}
                >
                  {t('taskTags.cancel')}
                </button>
                <button
                  className={dangerButton}
                  disabled={busy || blocked}
                  onClick={async () => {
                    if (
                      await run({
                        action: 'delete',
                        tagId: deletion.tagId,
                        revision: deletion.revision,
                        expectedCount: deletion.count,
                      })
                    )
                      closeEditor();
                  }}
                >
                  {t('taskTags.delete')}
                </button>
              </div>
            </div>
          )}
          {(error || blocked) && (
            <p
              className="mt-3 shrink-0 text-xs leading-5 text-[var(--text-secondary)]"
              role="alert"
            >
              {t(`taskTags.${blocked ? 'offline' : error}`)}
              {!blocked && error === 'loadFailed' && (
                <button
                  type="button"
                  className={button}
                  disabled={busy}
                  onClick={() => void run({ action: 'get', sessionIds: [session.id] })}
                >
                  {t('taskTags.retry')}
                </button>
              )}
            </p>
          )}
          {!formOpen && (
            <div className="mt-3 flex shrink-0 justify-end">
              <button className={primaryButton} disabled={busy} onClick={onClose}>
                {t('taskTags.done')}
              </button>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
