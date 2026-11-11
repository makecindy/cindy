import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import type { RemoteTerminalConnection, RemoteTerminalDescription } from '../../../../../shared/terminal-bridge';
import type { TabKindBodyProps } from '../../types';
import type { TerminalState } from './index';
import { TerminalSessionBody } from './TerminalTabBody';
import { getOrCreateXterm, type XtermEntry } from './lib/xtermPool';

const prefix = 'rightSidebar.terminal.remote.';

/** Main owns target identity and bindings; the renderer only edits non-secret SSH settings. */
export function RemoteTerminalSetup(props: TabKindBodyProps<TerminalState>) {
  const { ctx } = props;
  const { t } = useTranslation();
  const entry = useMemo(() => getOrCreateXterm(ctx.tabId), [ctx.tabId]);
  const draftKey = JSON.stringify([ctx.sessionId, ctx.deviceLinkDeviceId, ctx.remoteHostId]);
  const prepareState = useCallback(() => {
    const draft = entry.remoteDraft?.contextKey === draftKey ? entry.remoteDraft : undefined;
    return { phase: 'prepare' as const, connection: draft?.submitted ? draft.connection : undefined, editing: draft ? !draft.submitted : false };
  }, [entry, draftKey]);
  const context = useMemo(() => ({
    sessionId: ctx.sessionId,
    ...(ctx.deviceLinkDeviceId ? { deviceId: ctx.deviceLinkDeviceId } : {}),
  }), [ctx.sessionId, ctx.deviceLinkDeviceId]);
  const [setup, setSetup] = useState<
    | { phase: 'terminal'; ticket?: string }
    | { phase: 'prepare'; connection?: RemoteTerminalConnection; editing?: boolean }
    | { phase: 'form'; description: RemoteTerminalDescription }
    | { phase: 'error'; connection?: RemoteTerminalConnection; editing?: boolean }
  >(() => {
    const preparation = prepareState();
    return preparation.editing ? preparation : { phase: 'terminal' };
  });

  useEffect(() => {
    if (setup.phase !== 'prepare') return;
    let cancelled = false;
    const retryAfterClose = () => {
      // Invalidate the old request synchronously, before React runs cleanup.
      // Main may have invalidated its ticket while attempting disposal.
      cancelled = true;
      setSetup(current => current === setup ? { ...current } : current);
    };
    entry.closeCancelledListeners.add(retryAfterClose);
    if (!entry.closing) void window.electronAPI.terminal.describeRemote({ id: ctx.tabId, ...context, ...(setup.connection ? { connection: setup.connection } : {}) }).then((result) => {
      if (cancelled || entry.closing) return;
      // Release may confirm editing while this description is in flight.
      if (result.ticket && !setup.editing && !prepareState().editing) {
        setSetup({ phase: 'terminal', ticket: result.ticket });
      } else {
        setSetup({ phase: 'form', description: result });
      }
    }).catch(() => { if (!cancelled && !entry.closing) setSetup({ ...setup, phase: 'error' }); });
    return () => {
      cancelled = true;
      entry.closeCancelledListeners.delete(retryAfterClose);
    };
  }, [context, ctx.tabId, entry, setup, prepareState]);

  const ticket = setup.phase === 'terminal' ? setup.ticket : undefined;
  const remote = useMemo(() => ({ ...context, ...(ticket ? { ticket } : {}) }), [context, ticket]);
  // A release can commit editing intent after this body mounted. Read the pool
  // at recovery time, using the same draft policy as the initial mount.
  const prepare = useCallback(() => setSetup(prepareState()), [prepareState]);
  const connectionDisposed = useCallback(() => {
    entry.remoteDraft = { contextKey: draftKey, submitted: false };
  }, [entry, draftKey]);
  const editConnection = useCallback(() => {
    setSetup({ phase: 'prepare', editing: true });
  }, []);
  if (setup.phase === 'terminal') {
    return <TerminalSessionBody {...props} remote={remote} onPrepare={prepare} onConnectionDisposed={connectionDisposed} onEditConnection={editConnection} />;
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-y-auto bg-[var(--panel-bg)] p-4 text-13 text-[var(--text-primary)]">
      {setup.phase === 'prepare' && <p role="status" className="text-[var(--text-secondary)]">{t('rightSidebar.tabWindow.loading')}</p>}
      {setup.phase === 'error' && <div role="alert" className="mb-3 flex flex-wrap items-center gap-2">
        <span>{t(`${prefix}targetUnavailable`)}</span>
        <Button size="sm" variant="secondary" onClick={() => {
          // A draft reference may belong to an expired account generation. Fetch a
          // fresh description without resubmitting it, then let the user reselect a
          // candidate. Keep the draft (including its reference) so credentials are
          // never silently dropped in favour of a host-only launch.
          if (setup.connection?.hostRef) {
            if (entry.remoteDraft?.contextKey === draftKey) {
              entry.remoteDraft = { ...entry.remoteDraft, submitted: false };
            }
            setSetup({ phase: 'prepare', editing: true });
          } else {
            setSetup({ ...setup, phase: 'prepare' });
          }
        }}>{t('commonUi.retry')}</Button>
      </div>}
      {setup.phase === 'form' && <ConnectionForm description={setup.description} initialConnection={entry.remoteDraft?.contextKey === draftKey ? entry.remoteDraft.connection : undefined} entry={entry} draftKey={draftKey} onConnect={(connection) => {
        entry.remoteDraft = { contextKey: draftKey, connection, submitted: true };
        setSetup({ phase: 'prepare', connection });
      }} />}
    </div>
  );
}

function ConnectionForm({ description, initialConnection, entry, draftKey, onConnect }: {
  description: RemoteTerminalDescription;
  initialConnection?: RemoteTerminalConnection;
  entry: XtermEntry;
  draftKey: string;
  onConnect: (connection: RemoteTerminalConnection) => void;
}) {
  const { t } = useTranslation();
  const [connection, setConnection] = useState<RemoteTerminalConnection>(initialConnection ?? description.connection ?? { host: '' });
  const updateConnection = (value: RemoteTerminalConnection) => {
    entry.remoteDraft = { contextKey: draftKey, connection: value, submitted: false };
    setConnection(value);
  };
  // Saved legacy bindings may have credentials without a matching pool candidate.
  // Offer the current binding too, so stale drafts can be explicitly reselected.
  const candidates = description.connection?.hostRef && !description.candidates.some(candidate => candidate.hostRef === description.connection?.hostRef)
    ? [description.connection, ...description.candidates]
    : description.candidates;
  const staleReference = Boolean(connection.hostRef && !candidates.some(candidate =>
    candidate.hostRef === connection.hostRef && candidate.host === connection.host &&
    candidate.user === connection.user && candidate.port === connection.port,
  ));
  const [selected, setSelected] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const hostInput = useRef<HTMLInputElement>(null);
  const userInput = useRef<HTMLInputElement>(null);
  const host = connection.host.trim();
  const user = connection.user?.trim() ?? '';
  // Main repeats validation before launching SSH. Do not accept option-like names or control characters.
  const hostInvalid = host.length > 253 || !/^[a-zA-Z0-9_.:][a-zA-Z0-9_.:\-]*$/.test(host);
  const userInvalid = Boolean(user && (user.length > 128 || !/^[a-zA-Z0-9_][a-zA-Z0-9_.\-]*$/.test(user)));

  return (
    <form className="flex min-w-0 flex-col gap-3" onSubmit={(event) => {
      event.preventDefault();
      setSubmitted(true);
      if (staleReference) return;
      if (hostInvalid || userInvalid) {
        const input = hostInvalid ? hostInput.current : userInput.current;
        input?.focus({ preventScroll: true });
        input?.scrollIntoView?.({ block: 'nearest' });
        return;
      }
      onConnect({ ...connection, host, user: user || undefined });
    }}>
      <p className="text-[var(--text-secondary)]">{t(`${prefix}setupDescription`)}</p>
      {staleReference && <p role="alert" className="text-[var(--text-secondary)]">{t(`${prefix}selectAgain`)}</p>}
      {candidates.length > 0 && <Select
        label={t(`${prefix}selectedHost`)} value={selected}
        options={candidates.map((candidate, index) => ({ value: String(index), label: candidate.user ? `${candidate.user}@${candidate.host}` : candidate.host }))}
        onValueChange={(value) => {
          const candidate = candidates[Number(value)];
          if (candidate) { setSelected(value); updateConnection({ ...candidate }); }
        }}
      />}
      <FormField label={t(`${prefix}host`)} required error={submitted && hostInvalid ? t(`${prefix}hostInvalid`) : undefined}>
        {(field) => <Input {...field} inputRef={hostInput} value={connection.host} onChange={(value) => { setSelected(''); updateConnection({ ...connection, host: value, hostRef: undefined }); }} autoComplete="off" spellCheck={false} />}
      </FormField>
      <FormField label={t(`${prefix}user`)} hint={t(`${prefix}optional`)} error={submitted && userInvalid ? t(`${prefix}userInvalid`) : undefined}>
        {(field) => <Input {...field} inputRef={userInput} value={connection.user ?? ''} onChange={(value) => { setSelected(''); updateConnection({ ...connection, user: value, hostRef: undefined }); }} autoComplete="off" spellCheck={false} />}
      </FormField>
      <div><Button type="submit" size="sm" variant="primary" disabled={staleReference}>{t(`${prefix}connect`)}</Button></div>
    </form>
  );
}
