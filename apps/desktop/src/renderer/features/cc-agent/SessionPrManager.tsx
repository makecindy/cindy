import { useEffect, useRef, useState } from 'react';
import {
  GitPullRequest,
  Menu,
  MoreHorizontal,
  Pin,
  PinOff,
  RotateCcw,
  Trash2,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  prStatusKey,
  sessionPrUrl,
  type PrStatusResult,
  type SessionPrRef,
  type SessionPrRefAction,
} from '@cindy/maker-shared';
import { SortableList } from '@/components/sidebar/SortableList';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import { PR_STATUS_ICON, PR_STATUS_COLOR } from './gitContextPrVisuals';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ChromeIconButton } from '@/components/title-bar/ChromeIconButton';
import { usePrActions } from '@/contexts/PrRefsContext';
import { useAuth } from '@/contexts/AuthContext';
import { getStickySessionDeviceId } from '@/features/device-link/stickySessionOrigin';
import { extractIpcError } from '@/utils/ipcError';
import type { Session } from '@/lib/ccAgent.types';

// Matches main/git-context/prStatusService.ts MAX_BATCH; it is not exported.
const PR_STATUS_BATCH_SIZE = 10;
const PR_MANAGER_STATUS_LIMIT = 20;

function statusCandidates(rows: SessionPrRef[]): SessionPrRef[] {
  return rows
    .filter((row) => row.removedAt == null)
    .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)))
    .slice(0, PR_MANAGER_STATUS_LIMIT);
}

/** Edits associations on their owning host; GitHub itself is never mutated. */
export function SessionPrManager({
  session,
  readOnly = false,
}: {
  session: Session;
  readOnly?: boolean;
}) {
  const { t } = useTranslation();
  const { dataOwnerId } = useAuth();
  const { invalidateRemotePrRefs } = usePrActions();
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<SessionPrRef[] | null>(null);
  const [statuses, setStatuses] = useState<Map<string, PrStatusResult>>(new Map());
  const requestedStatusIds = useRef(new Map<string, number>());
  const statusSequence = useRef(0);
  const statusQueue = useRef<Promise<void>>(Promise.resolve());
  const handleElements = useRef(new Map<string, HTMLButtonElement>());
  const reorderFocus = useRef<string | null>(null);
  const requestBusy = useRef(false);
  const reducedMotion = useReducedMotion();
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const requestSequence = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const focusInput = useRef(false);
  const deviceId = session.deviceLinkDeviceId ?? getStickySessionDeviceId(session.id);
  useEffect(() => {
    setOpen(false);
    setRows(null);
    setStatuses(new Map());
    requestedStatusIds.current.clear();
    statusQueue.current = Promise.resolve();
    requestBusy.current = false;
    reorderFocus.current = null;
    setUrl('');
    setBusy(false);
    setError('');
    return () => {
      generation.current += 1;
    };
  }, [session.id, deviceId, dataOwnerId, readOnly]);
  useEffect(() => {
    if (open && !busy && focusInput.current) {
      focusInput.current = false;
      inputRef.current?.focus();
    }
  }, [open, busy]);

  useEffect(() => {
    if (!busy && reorderFocus.current) {
      const element = handleElements.current.get(reorderFocus.current);
      reorderFocus.current = null;
      // Restore the moved handle after busy controls become enabled again.
      if (document.activeElement === document.body || document.activeElement === element) {
        element?.focus();
      }
    }
  }, [rows, busy]);

  const fetchStatuses = async (result: SessionPrRef[], gen: number) => {
    const activeIds = new Set(result.filter((row) => row.removedAt == null).map((row) => row.id));
    for (const id of requestedStatusIds.current.keys()) {
      if (!activeIds.has(id)) requestedStatusIds.current.delete(id);
    }
    const pending = statusCandidates(result).filter(
      (row) => !requestedStatusIds.current.has(row.id),
    );
    if (pending.length === 0) return;
    setStatuses((previous) => {
      const next = new Map(previous);
      for (const row of pending) next.delete(prStatusKey(row));
      return next;
    });
    const sequence = ++statusSequence.current;
    for (const row of pending) requestedStatusIds.current.set(row.id, sequence);
    // Add/restore may finish while an earlier batch is still in flight. Queue
    // those rows too, so one open generation never makes concurrent requests.
    statusQueue.current = statusQueue.current.then(async () => {
      for (let offset = 0; offset < pending.length; offset += PR_STATUS_BATCH_SIZE) {
        if (gen !== generation.current) return;
        const batch = pending
          .slice(offset, offset + PR_STATUS_BATCH_SIZE)
          .filter((row) => requestedStatusIds.current.get(row.id) === sequence);
        if (batch.length === 0) continue;
        const queries = batch.map(({ owner, repo, prNumber }) => ({ owner, repo, prNumber }));
        try {
          const fetched = deviceId
            ? ((await window.electronAPI.deviceLink.invoke(deviceId, 'git-context:pr-status', [
                { sessionId: session.id, queries },
              ])) as PrStatusResult[])
            : await window.electronAPI.gitContext.getPrStatuses(queries);
          if (gen !== generation.current) return;
          setStatuses((previous) => {
            if (gen !== generation.current) return previous;
            const next = new Map(previous);
            const currentKeys = new Set(
              batch
                .filter((row) => requestedStatusIds.current.get(row.id) === sequence)
                .map(prStatusKey),
            );
            for (const status of fetched) {
              if (currentKeys.has(prStatusKey(status))) next.set(prStatusKey(status), status);
            }
            return next;
          });
        } catch {
          // A failed batch leaves its rows untitled; later batches still run.
        }
      }
    });
    await statusQueue.current;
  };

  const changeOpen = (next: boolean) => {
    generation.current += 1;
    requestBusy.current = false;
    requestedStatusIds.current.clear();
    statusQueue.current = Promise.resolve();
    reorderFocus.current = null;
    setStatuses(new Map());
    setRows(null);
    setBusy(false);
    setError('');
    setOpen(next);
    if (next) {
      focusInput.current = !readOnly;
      void run({ action: 'list' });
    }
  };

  const invokeManage = async (operation: SessionPrRefAction | { action: 'list' }) => {
    const input = { sessionId: session.id, ...operation };
    return deviceId
      ? ((await window.electronAPI.deviceLink.invoke(deviceId, 'git-context:pr-refs:manage', [
          input,
        ])) as SessionPrRef[])
      : await window.electronAPI.gitContext.managePrRefs(input);
  };

  const run = async (operation: SessionPrRefAction | { action: 'list' }) => {
    if (requestBusy.current) return;
    requestBusy.current = true;
    const requestSessionId = session.id;
    const gen = generation.current;
    const request = ++requestSequence.current;
    const isCurrent = () => gen === generation.current && request === requestSequence.current;
    setBusy(true);
    setError('');
    try {
      const result = await invokeManage(operation);
      // The host mutation survives closing the manager; only UI updates expire.
      if (deviceId && operation.action !== 'list') invalidateRemotePrRefs(requestSessionId);
      if (!isCurrent()) return;
      setRows(result);
      void fetchStatuses(result, gen);
      if (operation.action === 'add') setUrl('');
    } catch (err) {
      if (!isCurrent()) return;
      const code = extractIpcError(err)?.code;
      const key =
        code === 'UNSUPPORTED_CAPABILITY' || code === 'DEVICE_LINK_CHANNEL_NOT_ALLOWED'
          ? 'errors.unsupported'
          : operation.action === 'reorder'
            ? 'errors.reorderFailed'
            : code === 'INVALID_PARAMS' && operation.action === 'add'
              ? 'errors.invalidUrl'
              : code === 'INVALID_PARAMS' && operation.action === 'pin'
                ? 'pinLimit'
                : code === 'ALREADY_EXISTS'
                  ? 'errors.duplicate'
                  : code === 'NOT_FOUND'
                    ? 'errors.notFound'
                    : code === 'PRECONDITION_FAILED'
                      ? 'errors.verifyFailed'
                      : 'errors.failed';
      setError(t(`ccAgent.gitContext.pr.manage.${key}`));
      if (operation.action === 'reorder') {
        try {
          const refreshed = await invokeManage({ action: 'list' });
          if (!isCurrent()) return;
          setRows(refreshed);
          void fetchStatuses(refreshed, gen);
        } catch {
          // Keep the reorder explanation and last known rows if refresh also fails.
        }
      }
    } finally {
      if (isCurrent()) {
        requestBusy.current = false;
        setBusy(false);
      }
    }
  };

  const active = rows?.filter((r) => r.removedAt == null) ?? [];
  const statusCandidateIds = new Set(statusCandidates(active).map((row) => row.id));
  const removed = rows?.filter((r) => r.removedAt != null) ?? [];
  const pinned = active.filter((r) => r.pinned).length;
  const reorder = (ids: string[], focusId?: string) => {
    if (busy || requestBusy.current) return;
    reorderFocus.current = focusId ?? null;
    void run({ action: 'reorder', ids });
  };
  const renderRow = (ref: SessionPrRef, removed = false) => {
    const status = statusCandidateIds.has(ref.id) ? statuses.get(prStatusKey(ref)) : undefined;
    const kind = status?.ok ? status.status : null;
    const Icon = kind ? PR_STATUS_ICON[kind] : GitPullRequest;
    const title = status?.ok ? status.title.trim() : '';
    return (
      <div
        key={ref.id}
        ref={(element) => {
          const handle = element?.querySelector<HTMLButtonElement>('[data-pr-drag-handle]');
          if (handle) handleElements.current.set(ref.id, handle);
          else handleElements.current.delete(ref.id);
        }}
        className="flex items-center justify-between gap-2 py-1"
      >
        <div className="flex min-w-0 items-center gap-2">
          {!removed && (
            <Icon
              size={12}
              className="shrink-0"
              style={{ color: kind ? PR_STATUS_COLOR[kind] : 'var(--text-tertiary)' }}
            />
          )}
          <div className="min-w-0">
            <a
              href={sessionPrUrl(ref)}
              onClick={(event) => {
                event.preventDefault();
                void window.electronAPI.openExternal(sessionPrUrl(ref));
              }}
              className={`block truncate rounded-md hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] ${title ? 'text-13 text-[var(--text-primary)]' : 'text-12 text-[var(--text-secondary)]'}`}
              title={title || `${ref.owner}/${ref.repo} #${ref.prNumber}`}
            >
              {title || `${ref.repo} #${ref.prNumber}`}
            </a>
            {title && (
              <div
                className="truncate text-12 text-[var(--text-secondary)]"
                title={`${ref.owner}/${ref.repo} #${ref.prNumber}`}
              >
                {ref.repo} #{ref.prNumber}
                {kind && <> · {t(`ccAgent.gitContext.pr.status.${kind}`)}</>}
              </div>
            )}
          </div>
        </div>
        {!readOnly && (
          <div className="flex shrink-0 items-center">
            {removed ? (
              <ChromeIconButton
                disabled={busy}
                aria-label={t('ccAgent.gitContext.pr.manage.restore')}
                onClick={() => void run({ action: 'restore', id: ref.id })}
              >
                <RotateCcw size={14} />
              </ChromeIconButton>
            ) : (
              <>
                <ChromeIconButton
                  disabled={busy || (!ref.pinned && pinned >= 3)}
                  disabledTooltip={
                    !ref.pinned && pinned >= 3
                      ? t('ccAgent.gitContext.pr.manage.pinLimit')
                      : undefined
                  }
                  aria-label={t(`ccAgent.gitContext.pr.manage.${ref.pinned ? 'unpin' : 'pin'}`)}
                  aria-pressed={ref.pinned === true}
                  onClick={() => void run({ action: ref.pinned ? 'unpin' : 'pin', id: ref.id })}
                >
                  {ref.pinned ? <PinOff size={14} /> : <Pin size={14} />}
                </ChromeIconButton>
                <ChromeIconButton
                  disabled={busy}
                  aria-label={t('ccAgent.gitContext.pr.manage.remove')}
                  onClick={() => void run({ action: 'remove', id: ref.id })}
                >
                  <Trash2 size={14} />
                </ChromeIconButton>
                <ChromeIconButton
                  data-pr-drag-handle=""
                  disabled={busy}
                  aria-label={t('ccAgent.gitContext.pr.manage.dragHandle', {
                    repo: ref.repo,
                    number: ref.prNumber,
                  })}
                  aria-description={t('ccAgent.gitContext.pr.manage.reorderHint')}
                  tooltip={t('ccAgent.gitContext.pr.manage.reorderHint')}
                  className="cursor-grab text-[var(--text-tertiary)] enabled:hover:text-[var(--text-secondary)] focus-visible:text-[var(--text-secondary)] active:cursor-grabbing disabled:cursor-default"
                  onKeyDown={(event) => {
                    if (
                      event.target !== event.currentTarget ||
                      !event.altKey ||
                      !['ArrowUp', 'ArrowDown'].includes(event.key)
                    )
                      return;
                    event.preventDefault();
                    const group = active.filter(
                      (row) => Boolean(row.pinned) === Boolean(ref.pinned),
                    );
                    const index = group.findIndex((row) => row.id === ref.id);
                    const next = index + (event.key === 'ArrowUp' ? -1 : 1);
                    if (next < 0 || next >= group.length) return;
                    const ids = group.map((row) => row.id);
                    [ids[index], ids[next]] = [ids[next], ids[index]];
                    reorder(ids, ref.id);
                  }}
                >
                  <Menu size={14} aria-hidden="true" />
                </ChromeIconButton>
              </>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <Popover open={open} onOpenChange={changeOpen}>
      <PopoverTrigger asChild>
        <ChromeIconButton aria-label={t('ccAgent.gitContext.pr.manage.title')}>
          <MoreHorizontal size={14} />
        </ChromeIconButton>
      </PopoverTrigger>
      <PopoverContent
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            changeOpen(false);
          }
        }}
        align="end"
        className="w-80 max-w-[calc(100vw-24px)] p-3"
        aria-label={t('ccAgent.gitContext.pr.manage.title')}
      >
        <div className="flex items-center justify-between gap-2">
          <span className="text-13 font-medium">{t('ccAgent.gitContext.pr.manage.title')}</span>
          <ChromeIconButton aria-label={t('common.dismiss')} onClick={() => changeOpen(false)}>
            <X size={14} />
          </ChromeIconButton>
        </div>
        <p className="mb-2 text-xs text-[var(--text-secondary)]">
          {t('ccAgent.gitContext.pr.manage.hint')}
        </p>
        <div className="max-h-60 overflow-y-auto">
          {readOnly
            ? active.map((ref) => renderRow(ref))
            : [true, false].map((isPinned) => (
                <SortableList
                  key={String(isPinned)}
                  items={active.filter((ref) => Boolean(ref.pinned) === isPinned)}
                  getId={(ref) => ref.id}
                  onReorder={(ids) => reorder(ids)}
                  renderItem={(ref) => renderRow(ref)}
                  disabled={busy}
                  handle="[data-pr-drag-handle]"
                  filter="button:not([data-pr-drag-handle]), input, textarea, select, a, [data-no-drag]"
                  reducedMotion={reducedMotion}
                />
              ))}
          {rows !== null && active.length === 0 && (
            <p className="py-2 text-xs text-[var(--text-secondary)]">
              {t('ccAgent.gitContext.pr.manage.empty')}
            </p>
          )}
          {removed.length > 0 && (
            <details className="mt-2 text-xs text-[var(--text-secondary)]">
              <summary className="cursor-pointer">
                {t('ccAgent.gitContext.pr.manage.removed', { count: removed.length })}
              </summary>
              {removed.map((ref) => renderRow(ref, true))}
            </details>
          )}
        </div>
        {!readOnly && (
          <form
            className="mt-3 border-t border-[var(--border-default)] pt-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (!busy && url.trim()) void run({ action: 'add', url: url.trim() });
            }}
          >
            <label htmlFor={`pr-url-${session.id}`} className="mb-2 block text-xs">
              {t('ccAgent.gitContext.pr.manage.addLabel')}
            </label>
            <div className="flex items-center gap-2">
              <Input
                inputRef={inputRef}
                id={`pr-url-${session.id}`}
                value={url}
                onChange={setUrl}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && event.nativeEvent.isComposing)
                    event.preventDefault();
                }}
                disabled={busy || rows === null}
                placeholder="https://github.com/…/pull/…"
                maxLength={2048}
                className="min-w-0 text-xs"
              />
              <Button size="sm" type="submit" disabled={busy || !url.trim()}>
                {t('ccAgent.gitContext.pr.manage.add')}
              </Button>
            </div>
          </form>
        )}
        {busy && (
          <p role="status" className="mt-2 text-xs text-[var(--text-secondary)]">
            {t('ccAgent.gitContext.pr.manage.loading')}
          </p>
        )}
        {error && (
          <p role="alert" className="mt-2 text-xs text-[var(--error-fg)]">
            {error}
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}
