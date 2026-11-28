import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorCode, useBlockRetry } from './blockRetry';
import { SETTLE_DELAYS_MS, useSettleUnknown } from './useSettleUnknown';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import type { ManagementItem, ManagementResult } from '../../../shared/settingsManagement';
import type { CloudSettingsClient } from './client';
import { toast } from '@/lib/toast';
type Operation = Extract<ManagementResult, { kind: 'operation' }>;
type Action = ManagementItem['actions'][number];
/** An authorization whose progress could not be read: read back, never run or cancelled again. */
type Unknown = { operationId: string; itemId?: string; intent?: Action['intent']; until?: number };
const activeOperation = (op?: Operation) => !!op && ['running', 'waiting'].includes(op.phase);
export const supportedActions = (item: ManagementItem) =>
  item.actions.filter(
    (a) => ['authorize', 'disconnect'].includes(a.intent) && a.fields.length === 0,
  );
export const supportedBotActions = (item: ManagementItem) =>
  item.actions.filter((action) =>
    ['authorize', 'connect', 'reconnect', 'disconnect'].includes(action.intent),
  );

export interface CloudAuthorizationProps {
  client: CloudSettingsClient;
  online: boolean;
  active: boolean;
  name: string;
  trial?: boolean;
  refresh?: number;
  /** The page shows its own read failure: this block does not report one as well. */
  pageFailed?: boolean;
}
export function useCloudAuthorization(
  { client, online, active, name, trial = false, refresh = 0, pageFailed = false }: CloudAuthorizationProps,
  section: 'providers' | 'bots',
  /** Keep items whose actions need fields (API keys, new connections). */
  { all = false }: { all?: boolean } = {},
) {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();
  const [items, setItems] = useState<ManagementItem[]>([]);
  const [selected, setSelected] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [readCode, setReadCode] = useState<string>();
  const [readFailures, setReadFailures] = useState(0);
  const [operation, setOperation] = useState<Operation>();
  const [operationItem, setOperationItem] = useState<string>();
  const operationItemRef = useRef<string | undefined>(undefined);
  operationItemRef.current = operationItem;
  const [callback, setCallback] = useState('');
  const [requesting, setRequesting] = useState(false);
  const scope = useRef({ client, online });
  scope.current = { client, online };
  const alive = useRef(true);
  const pending = useRef(false);
  const sequence = useRef(0);
  const operationVersion = useRef(0);
  const opened = useRef(new Set<string>());
  const operationRef = useRef(operation);
  operationRef.current = operation;
  // Callers that need an outcome (e.g. a native toast) wait for the terminal phase.
  const settled = useRef(new Map<string, (phase: Operation['phase']) => void>());
  const itemsRef = useRef<ManagementItem[]>([]);
  /**
   * How a provider sign-in ends, as the client's provider wizard says it: 「已登录 X」,
   * or 「X 登录失败，请重试」 for a failure or an expiry; a cancel says nothing. A caller that waits
   * for the outcome (the shared wizard, the native login) says it itself. Bots keep their card's
   * own line.
   */
  const report = (phase: Operation['phase'], operationId: string, itemId?: string) => {
    if (section !== 'providers' || settled.current.has(operationId)) return;
    const name = itemsRef.current.find((item) => item.id === itemId)?.label ?? '';
    if (phase === 'succeeded') toast.success(t('settings.providers.wizard.authorizedToast', { name }));
    else if (phase === 'failed' || phase === 'expired')
      toast.error(t('settings.providers.wizard.authorizeFailed', { name }));
  };
  const finish = (op: Operation) => {
    if (activeOperation(op)) return;
    const resolve = settled.current.get(op.operationId);
    settled.current.delete(op.operationId);
    resolve?.(op.phase);
  };
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      sequence.current++;
      for (const resolve of settled.current.values()) resolve('unknown');
      settled.current.clear();
    };
  }, [client]);
  const current = () => alive.current && scope.current.client === client && scope.current.online;
  const accept = (result: ManagementResult, id: string) => {
    if (result.kind !== 'operation' || result.operationId !== id) throw new Error('SCOPE_CHANGED');
    if (current()) {
      const ended = !activeOperation(result) && result.phase !== 'unknown';
      if (ended && operationRef.current?.operationId === id && operationRef.current.phase !== result.phase)
        report(result.phase, id, operationItemRef.current);
      operationRef.current = result;
      setOperation(result);
    }
    finish(result);
    return result;
  };
  /** Every listed item; undefined once the read is superseded. Throws when it cannot read. */
  const listAll = async (seq: number): Promise<ManagementItem[] | undefined> => {
    const values: ManagementItem[] = [];
    let offset = 0;
    // Bounded pagination; never render a partial provider list as complete.
    for (let page = 0; page < 128; page++) {
      const result = await client.manage!({ operation: 'list', section, offset });
      if (!current() || sequence.current !== seq) return;
      if (result.kind !== 'page' || result.section !== section || (result.offset ?? 0) !== offset)
        throw new Error('INVALID_PAGE');
      values.push(...result.items);
      if (result.nextOffset === undefined) {
        // A connection form or a read-only state is still a real IM channel.
        // Filtering by OAuth buttons hid every unconfigured personal bot.
        const visible =
          section === 'bots' || all
            ? values
            : values.filter((item) => supportedActions(item).length);
        if (new Set(visible.map((item) => item.id)).size !== visible.length)
          throw new Error('INVALID_PAGE');
        setItems(visible);
        setSelected((old) => (visible.some((item) => item.id === old) ? old : visible[0]?.id));
        return visible;
      }
      if (result.nextOffset <= offset) throw new Error('INVALID_PAGE');
      offset = result.nextOffset;
    }
    throw new Error('TOO_MANY_PAGES');
  };
  /** Resolves with the listed items, so a caller can run a fresh action right away. */
  const load = async (): Promise<ManagementItem[] | undefined> => {
    if (!current() || !client.manage) return;
    const seq = ++sequence.current;
    setLoading(true);
    try {
      const visible = await listAll(seq);
      if (visible) setFailure(undefined);
      return visible;
    } catch (error) {
      if (current() && sequence.current === seq) {
        setFailure('readFailed');
        setReadCode(errorCode(error));
        setReadFailures((count) => count + 1);
      }
    } finally {
      if (current() && sequence.current === seq) setLoading(false);
    }
  };
  // Progress that could not be read is read back with a backoff, from the operation or, if
  // that cannot be read, from the item's own state. A sign-in opened in the browser is waited for
  // until it expires. Nothing is run or cancelled again on the user's behalf.
  const viaList = useRef(false);
  const unknown = useSettleUnknown<Unknown>({
    delays: SETTLE_DELAYS_MS.authorization,
    until: (pending) => pending.until,
    check: async (pending) => {
      if (!current()) throw new Error('SCOPE_CHANGED');
      try {
        const result = await client.manage!({
          operation: 'status',
          operationId: pending.operationId,
        });
        if (result.kind === 'operation' && result.operationId === pending.operationId) {
          viaList.current = false;
          accept(result, pending.operationId);
          return 'done';
        }
      } catch {
        // Fall back to the item's state below.
      }
      const listed = await listAll(++sequence.current);
      const item = listed?.find((entry) => entry.id === pending.itemId);
      if (!item) throw new Error('UNREADABLE');
      viaList.current = true;
      const took =
        pending.intent === 'disconnect' ? item.status !== 'connected' : item.status === 'connected';
      if (took) return 'done';
      return pending.until !== undefined && Date.now() < pending.until ? 'pending' : 'notDone';
    },
    onSettled: (verdict, pending) => {
      if (!current() || operationRef.current?.operationId !== pending.operationId) return;
      if (verdict === 'done' && !viaList.current) {
        // The operation answered: an active one is polled as usual, a finished one reread.
        if (!activeOperation(operationRef.current)) void load();
        return;
      }
      const phase = verdict === 'done' ? 'succeeded' : 'failed';
      operationRef.current = undefined;
      setOperation(undefined);
      report(phase, pending.operationId, pending.itemId);
      if (verdict === 'notDone' && section === 'bots') setFailure('authNotDone');
      finish({ kind: 'operation', operationId: pending.operationId, phase });
    },
  });
  const settle = (pending: Unknown) => {
    const op = { kind: 'operation', operationId: pending.operationId, phase: 'unknown' } as const;
    operationRef.current = op;
    setOperation(op);
    void unknown.start(pending);
  };
  useEffect(() => () => unknown.stop(), [client]);
  useEffect(() => {
    if (active && online && !activeOperation(operationRef.current)) void load();
  }, [client, online, active, refresh]);
  useEffect(() => {
    if (!online) {
      sequence.current++;
      setCallback('');
    }
  }, [online]);
  useEffect(() => {
    setCallback('');
  }, [selected, operation?.operationId, operation?.phase]);
  const run = async (
    item: ManagementItem,
    action: Action,
    values: Record<string, string> = {},
    options: { confirmed?: boolean; settled?(phase: Operation['phase']): void } = {},
  ) => {
    if (
      !current() ||
      pending.current ||
      activeOperation(operationRef.current) ||
      unknown.state ||
      !client.manage
    )
      return options.settled?.('cancelled');
    if (action.expiresAt <= Date.now()) {
      // A provider says it as a failed sign-in; a bot card keeps its line.
      if (section === 'providers' && !options.settled)
        toast.error(t('settings.providers.wizard.authorizeFailed', { name: item.label }));
      else if (section === 'bots') setFailure('authExpired');
      void load();
      return options.settled?.('expired');
    }
    // Lock before a confirmation dialog to prevent double clicks opening parallel requests.
    pending.current = true;
    setRequesting(true);
    try {
      if (
        action.intent === 'disconnect' &&
        !options.confirmed &&
        !(await confirm({
          title: t('settings.providers.button.disconnect'),
          description: t('cloudSettings.authDisconnect', { name, provider: item.label }),
          confirmText: t('settings.providers.button.disconnect'),
        }))
      )
        return options.settled?.('cancelled');
      if (!current()) return options.settled?.('cancelled');
      const operationId = crypto.randomUUID();
      operationVersion.current++;
      setOperationItem(item.id);
      operationRef.current = { kind: 'operation', operationId, phase: 'running' };
      setOperation(operationRef.current);
      setFailure(undefined);
      if (options.settled) settled.current.set(operationId, options.settled);
      try {
        const next = accept(
          await client.manage({ operation: 'run', actionId: action.id, operationId, values }),
          operationId,
        );
        if (!activeOperation(next)) await load();
      } catch {
        // Keep the operation ID: reading its status is safe, running the login again is not.
        if (current()) settle({ operationId, itemId: item.id, intent: action.intent });
        else finish({ kind: 'operation', operationId, phase: 'unknown' });
      }
    } finally {
      pending.current = false;
      if (alive.current) setRequesting(false);
    }
  };
  const operate = async (kind: 'cancel' | 'respond') => {
    if (!current() || pending.current || !operation || unknown.state || !client.manage) return;
    pending.current = true;
    setRequesting(true);
    setFailure(undefined);
    operationVersion.current++;
    const id = operation.operationId;
    const value = callback.trim();
    setCallback('');
    try {
      const result = await client.manage(
        kind === 'respond'
          ? { operation: kind, operationId: id, value }
          : { operation: kind, operationId: id },
      );
      accept(result, id);
      if (kind === 'cancel' && current()) {
        // A cancel says nothing on the provider page.
        if (section === 'bots') setFailure('authCancelled');
        setOperation(undefined);
      }
      if (current() && !activeOperation(result as Operation)) await load();
    } catch {
      if (!current()) return;
      // A stop whose result is unknown is read back like any other.
      if (kind === 'cancel') settle({ operationId: id, itemId: operationItem });
      // A code that could not be sent is a failed sign-in.
      else if (section === 'providers') report('failed', id, operationItem);
      else setFailure('authResponseFailed');
    } finally {
      pending.current = false;
      if (alive.current) setRequesting(false);
    }
  };
  useEffect(() => {
    if (!online || !activeOperation(operation) || !client.manage) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const version = operationVersion.current;
      try {
        const result = await client.manage!({
          operation: 'status',
          operationId: operation!.operationId,
        });
        if (cancelled || !current()) return;
        if (version !== operationVersion.current) {
          timer = setTimeout(() => void poll(), 1500);
          return;
        }
        const next = accept(result, operation!.operationId);
        if (!activeOperation(next)) {
          await load();
          return;
        }
      } catch {
        if (!cancelled && current() && version === operationVersion.current) {
          // A sign-in already opened in the browser may still finish: wait for it until it expires.
          const shown = operation!.prompt;
          const signingIn = !!shown && opened.current.has(`${operation!.operationId}:${shown.url}`);
          settle({
            operationId: operation!.operationId,
            itemId: operationItem,
            until: signingIn ? shown!.expiresAt : undefined,
          });
        }
        return;
      }
      if (!cancelled) timer = setTimeout(() => void poll(), 1500);
    };
    timer = setTimeout(() => void poll(), 1000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [client, online, operation?.operationId, operation?.phase]);
  const prompt =
    online &&
    activeOperation(operation) &&
    operation?.prompt &&
    operation.prompt.expiresAt > Date.now()
      ? operation.prompt
      : undefined;
  const open = async (url: string) => {
    if (!current() || !prompt || url !== prompt.url || prompt.expiresAt <= Date.now())
      throw new Error('EXPIRED');
    if (trial) return; // Trial never opens or logs in to an actual third-party account.
    const result = await window.electronAPI.openExternal(url);
    if (!result.success) throw new Error('OPEN_FAILED');
  };
  useEffect(() => {
    if (!active || !prompt || !operation || trial || !current()) return;
    const key = `${operation.operationId}:${prompt.url}`;
    if (opened.current.has(key)) return;
    opened.current.add(key);
    void open(prompt.url).catch(() => {
      if (current()) setFailure('authOpenFailed');
    });
  }, [active, prompt?.url, operation?.operationId, online]);
  // A list that cannot be read is read again on its own before it says so.
  const readRetry = useBlockRetry({
    failed: failure === 'readFailed' && active && online,
    failures: readFailures,
    retry: () => void load(),
    paused: pageFailed,
  });
  // A provider's progress that could not be read: a warning toast whose button reads it once
  // more (as the client's remote page when a result is not confirmed).
  const unreadableNow = section === 'providers' && unknown.state === 'unreadable';
  useEffect(() => {
    if (!unreadableNow) return;
    toast.warning(t('settings.ghosts.remote.unknown'), {
      action: { label: t('cloudSettings.authCheck'), onClick: () => void unknown.reload() },
    });
  }, [unreadableNow]);
  itemsRef.current = items;
  return {
    t,
    /**
     * What the authorization is doing, for the line under its buttons. While an unknown result is
     * read back nothing is said, except that a sign-in opened in the browser is
     * waited for, which the owner has to finish there.
     */
    // As the client: no line while it runs, waits or is read back; a provider's end
    // is a toast (report). A bot card says only how a binding failed, in the card's own words.
    phaseText:
      section === 'bots' && !unknown.state && (operation?.phase === 'failed' || operation?.phase === 'expired')
        ? t(`settings.remoteControl.hook.binding.state.${operation.phase}`)
        : undefined,
    /** Its progress could not be read: a reload reads it once more, it never signs in again. */
    progressUnreadable:
      section === 'bots' && unknown.state === 'unreadable' ? { reload: unknown.reload } : undefined,
    /** Progress is being read back or could not be read: nothing else runs meanwhile. */
    settling: !!unknown.state,
    /** An unknown result is being read back: only a spinner shows it. */
    checking: unknown.state === 'checking',
    readFailure: readRetry.exhausted ? { code: readCode, reload: readRetry.reload } : undefined,
    items,
    selected,
    setSelected,
    loading,
    failure,
    setFailure,
    operation,
    operationItem,
    callback,
    setCallback,
    requesting,
    load,
    run,
    operate,
    prompt,
    open,
    busy: activeOperation(operation),
  };
}
