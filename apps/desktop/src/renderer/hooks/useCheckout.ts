import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { makerChatStore } from '@/lib/makerChatStore';
import {
  getRemoteSessionActivity,
  subscribeRemoteSessionActivity,
} from '@/features/device-link/remoteSessionActivityStore';
import { toast, type ToastAction } from '@/lib/toast';
import type {
  CheckoutRequest,
  CheckoutReply,
  CheckoutStatus,
  CheckoutReceipt,
} from '../../shared/worktreeCheckout';

export function formatCheckoutError(
  t: TFunction,
  code: string,
  status?: CheckoutStatus,
  branch?: string,
): string {
  if (code === 'occupied')
    return t('newChat.checkout.errors.occupied', {
      branch: branch?.replace(/^refs\/remotes\//, ''),
    });
  const collision = code === 'conflict' ? status?.ignoredCollision : undefined;
  return collision
    ? t('newChat.checkout.errors.ignored', {
        branch: collision.branch,
        file: collision.paths[0],
        count: collision.paths.length,
      })
    : t(`newChat.checkout.errors.${code}`);
}

/** Presentation state is fenced by execution computer and repository, including delayed write replies. */
export function useCheckout(
  repo: string | null,
  deviceId: string | null | undefined,
  supported: boolean,
  onBusyChange?: (busy: boolean) => void,
  observeSessionActivity = false,
) {
  const { t } = useTranslation();
  const key = JSON.stringify([repo, deviceId]);
  const currentKey = useRef(key);
  currentKey.current = key;
  const [state, setState] = useState<{
    key: string;
    status?: CheckoutStatus;
    busy?: boolean;
    error?: string;
    dialog?: { branch: string; status: CheckoutStatus };
    receipt?: CheckoutReceipt;
  }>({ key });
  const stateRef = useRef(state);
  stateRef.current = state;
  const active = useRef(false);
  const mounted = useRef(true);
  const scope = useMemo(() => ({ active: true }), [key]);
  const isCurrent = useCallback(
    () => scope.active && mounted.current && currentKey.current === key,
    [key, scope],
  );
  const actions = useRef<{
    undo?: (id: string) => Promise<void>;
    restore?: (id: string) => Promise<void>;
  }>({});
  const notices = useRef<
    Partial<Record<'undo' | 'saved', { id: string; message: string; action: ToastAction }>>
  >({});
  const undoToast = useRef<string | undefined>(undefined);
  const savedToast = useRef<{ identity: string; id?: string }>({ identity: '' });
  const errorToast = useRef<string | undefined>(undefined);
  const dismissError = useCallback(() => {
    if (errorToast.current) toast.dismiss(errorToast.current);
    errorToast.current = undefined;
  }, []);
  useEffect(() => {
    mounted.current = true;
    scope.active = true;
    return () => {
      mounted.current = false;
      scope.active = false;
      if (undoToast.current) toast.dismiss(undoToast.current);
      if (savedToast.current.id) toast.dismiss(savedToast.current.id);
      dismissError();
      undoToast.current = undefined;
      savedToast.current = { identity: '' };
      notices.current = {};
    };
  }, [key, dismissError, scope]);
  const serial = useRef(0);
  const invoke = useCallback(
    async (req: CheckoutRequest): Promise<CheckoutReply> =>
      deviceId
        ? ((await window.electronAPI.deviceLink.invoke(deviceId, 'worktree:checkout', [
            req,
          ])) as CheckoutReply)
        : window.electronAPI.worktreeCheckout(req),
    [deviceId],
  );
  const update = useCallback(
    (patch: Partial<typeof state>) => {
      if (isCurrent()) setState((old) => ({ ...(old.key === key ? old : { key }), ...patch }));
    },
    [key, isCurrent],
  );
  const reportError = useCallback(
    (code: string, status?: CheckoutStatus, branch?: string) => {
      if (!isCurrent()) return;
      update({ error: code });
      dismissError();
      errorToast.current = toast.error(formatCheckoutError(t, code, status, branch));
    },
    [key, t, update, dismissError, isCurrent],
  );
  const refresh = useCallback(
    async (branch?: string) => {
      if (!isCurrent() || !repo || !supported || active.current) return;
      const request = ++serial.current;
      try {
        const reply = await invoke({ action: 'status', baseRepo: repo, branch });
        if ('status' in reply && isCurrent() && request === serial.current) {
          update({ status: reply.status, error: undefined });
          return reply.status;
        }
      } catch {
        if (request === serial.current) {
          update({ status: undefined });
          reportError('git');
        }
      }
    },
    [repo, supported, invoke, key, update, reportError, isCurrent],
  );
  useEffect(() => {
    void refresh();
    const focus = () => {
      void refresh();
    };
    window.addEventListener('focus', focus);
    return () => window.removeEventListener('focus', focus);
  }, [refresh]);
  const sessionIds = JSON.stringify(
    state.key === key ? (state.status?.sessions.map((session) => session.id).sort() ?? []) : [],
  );
  useEffect(() => {
    if (!observeSessionActivity || !repo || !supported || state.busy) return;
    const ids = new Set<string>(JSON.parse(sessionIds));
    if (!ids.size) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight = false;
    let dirty = false;
    // Fixed 250 ms merge window: token updates do not read; bursts merge once.
    // During a slow read retain only one trailing invalidation, never overlap reads.
    const schedule = () => {
      dirty = true;
      if (disposed || inFlight || timer) return;
      timer = setTimeout(async () => {
        timer = undefined;
        if (disposed) return;
        dirty = false;
        inFlight = true;
        try {
          await refresh();
        } finally {
          inFlight = false;
          if (!disposed && dirty) schedule();
        }
      }, 250);
    };
    const snapshot = () => {
      const local = deviceId ? undefined : makerChatStore.getRunningSnapshot();
      return [...ids]
        .map((id) =>
          deviceId
            ? (getRemoteSessionActivity(id, deviceId)?.phase ?? 'unknown')
            : local?.get(id)?.isRunning === true,
        )
        .join('|');
    };
    let previous = snapshot();
    const changed = () => {
      const next = snapshot();
      if (next === previous) return;
      previous = next;
      schedule();
    };
    const unsubscribers: Array<(() => void) | undefined> = [];
    if (deviceId) {
      unsubscribers.push(
        subscribeRemoteSessionActivity((device, id) => {
          if ((!device || device === deviceId) && (!id || ids.has(id))) changed();
        }),
      );
    } else {
      unsubscribers.push(makerChatStore.subscribeAll(changed));
      const background = new Map<string, boolean>();
      const onBackground = (kind: string) => (event: { sessionId: string; active: boolean }) => {
        if (!ids.has(event.sessionId)) return;
        const id = kind + event.sessionId;
        if (background.get(id) === event.active) return;
        background.set(id, event.active);
        schedule();
      };
      const maker = window.electronAPI?.maker;
      unsubscribers.push(maker?.onSessionBackgroundActivityChanged?.(onBackground('model')));
      unsubscribers.push(maker?.onSessionBackgroundWorkChanged?.(onBackground('command')));
    }
    // Catch a known turn edge that landed while the initial status read was in flight.
    // Unknown/unloaded sessions are not evidence; the backend remains authoritative.
    if (!deviceId) {
      const local = makerChatStore.getRunningSnapshot();
      if (
        stateRef.current.status?.sessions.some((session) => {
          const known = local.get(session.id);
          return known && known.isRunning !== session.running;
        })
      )
        schedule();
    }
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      for (const unsubscribe of unsubscribers) unsubscribe?.();
    };
  }, [observeSessionActivity, repo, supported, key, deviceId, sessionIds, state.busy, refresh]);
  const mutate = useCallback(
    async (req: CheckoutRequest) => {
      if (!isCurrent() || active.current) return;
      dismissError();
      active.current = true;
      onBusyChange?.(true);
      ++serial.current;
      update({ busy: true, error: undefined });
      try {
        let reply: CheckoutReply | undefined;
        try {
          reply = await invoke(req);
          while ('pending' in reply && isCurrent())
            reply = await invoke({
              action: 'result',
              baseRepo: repo!,
              operationId: reply.operationId,
            });
        } catch (error) {
          // The write may already be committed. Recover its receipt, never replay it.
          for (let attempt = 0; attempt < 2 && isCurrent(); attempt++) {
            if (!('operationId' in req)) break;
            try {
              const recovered = await invoke({
                action: 'result',
                baseRepo: req.baseRepo,
                operationId: req.operationId,
              });
              if (!('pending' in recovered)) {
                reply = recovered;
                break;
              }
            } catch {
              // A second read can recover a transiently lost result response.
            }
          }
          if (!reply || 'pending' in reply) throw error;
        }
        if ('pending' in reply || !isCurrent()) return;
        let error: string | undefined = reply.blocked;
        if (reply.blocked === 'changed') {
          if (req.action === 'restore') {
            // The write preflight is authoritative; the cached saved entry may be stale.
            error =
              reply.status.current === req.expected &&
              !reply.status.stashes.some((stash) => stash.id === req.stashId)
                ? 'savedMissing'
                : 'restoreChanged';
          } else if (req.action === 'undo') error = 'undoChanged';
        }
        update({ status: reply.status, error });
        if (error)
          reportError(
            error,
            reply.status,
            req.action === 'switch'
              ? req.branch
              : req.action === 'undo'
                ? stateRef.current.receipt?.from
                : undefined,
          );
        return reply;
      } catch {
        reportError('git');
        // A lost reply is not permission to repeat checkout. Only re-read facts.
        if (isCurrent()) {
          try {
            const fresh = await invoke({ action: 'status', baseRepo: repo! });
            if ('status' in fresh) update({ status: fresh.status });
          } catch {
            /* Keep the uncertainty visible until the computer is reachable. */
          }
        }
      } finally {
        active.current = false;
        onBusyChange?.(false);
        update({ busy: false });
      }
    },
    [invoke, key, repo, update, onBusyChange, reportError, dismissError, isCurrent],
  );
  const performSwitch = useCallback(
    async (branch: string, status: CheckoutStatus, strategy: 'carry' | 'stash') => {
      if (!repo) return;
      const reply = await mutate({
        action: 'switch',
        baseRepo: repo,
        branch,
        expected: status.current,
        fingerprint: status.fingerprint,
        strategy,
        operationId: crypto.randomUUID(),
      });
      if (!reply) return;
      if (reply.blocked && !reply.receipt) {
        // Changed files require a fresh explicit decision, never an automatic retry.
        update({
          dialog: reply.status.files.length ? { branch, status: reply.status } : undefined,
        });
        return;
      }
      update({ dialog: undefined, receipt: reply.receipt });
      // A new switch retires the previous undo prompt, even when this one needs no toast.
      if (undoToast.current) toast.dismiss(undoToast.current);
      undoToast.current = undefined;
      delete notices.current.undo;
      if (reply.receipt) {
        const receipt = reply.receipt;
        const idle = receipt.sessions
          .filter((session) => !session.running)
          .map((session) => session.name)
          .join(', ');
        const fetched = receipt.fetchedCommits ?? 0;
        if (!receipt.hadChanges && !idle && !fetched) return;
        const message =
          t('newChat.checkout.switched', { branch: receipt.to }) +
          (receipt.hadChanges
            ? t(`newChat.checkout.${receipt.strategy === 'stash' ? 'stashed' : 'carried'}`)
            : '') +
          (fetched
            ? '\n' +
              t('newChat.checkout.fetched', {
                branch: branch.replace(/^refs\/remotes\//, ''),
                count: fetched,
              })
            : '') +
          (idle
            ? '\n' + t('newChat.checkout.sessionsContinue', { names: idle, branch: receipt.to })
            : '');
        const action: ToastAction = {
          label: t('newChat.checkout.undo'),
          onClick: () => {
            if (!isCurrent()) {
              toast.dismiss(id);
              return;
            }
            void actions.current.undo?.(receipt.id);
          },
        };
        const id = toast.success(message, { duration: 8000, action });
        undoToast.current = id;
        notices.current.undo = { id, message, action };
      }
    },
    [repo, mutate, update, key, t, isCurrent],
  );
  const picking = useRef(false);
  const pick = useCallback(
    async (branch: string) => {
      if (!isCurrent() || picking.current || active.current) return;
      dismissError();
      picking.current = true;
      onBusyChange?.(true);
      update({ busy: true });
      try {
        const status = await refresh(branch);
        if (!status || !isCurrent()) return;
        if (status.blocked) {
          reportError(status.blocked, status, branch);
          return;
        }
        if (status.files.length) update({ dialog: { branch, status } });
        else await performSwitch(branch, status, 'carry');
      } finally {
        picking.current = false;
        onBusyChange?.(false);
        update({ busy: false });
      }
    },
    [refresh, key, update, performSwitch, onBusyChange, reportError, dismissError, isCurrent],
  );
  const undo = useCallback(
    async (expectedReceiptId?: string) => {
      if (!isCurrent() || active.current || picking.current) return;
      dismissError();
      const matches = () =>
        stateRef.current.key === key &&
        !!stateRef.current.receipt &&
        (!expectedReceiptId || stateRef.current.receipt.id === expectedReceiptId);
      if (!repo) {
        reportError('undoUnavailable');
        return;
      }
      if (!matches()) {
        if (!(await refresh())) return;
        if (!matches()) {
          reportError('undoUnavailable');
          return;
        }
      }
      const previous = stateRef.current;
      const reply = await mutate({
        action: 'undo',
        baseRepo: repo,
        receiptId: previous.receipt!.id,
        operationId: crypto.randomUUID(),
      });
      if (reply && (reply.undoApplied || !reply.blocked)) {
        update({ receipt: undefined });
        if (undoToast.current) toast.dismiss(undoToast.current);
        undoToast.current = undefined;
        delete notices.current.undo;
        if (!reply.blocked) toast.success(t('newChat.checkout.undone'));
      }
    },
    [repo, key, mutate, update, t, refresh, reportError, dismissError, isCurrent],
  );
  const restore = useCallback(
    async (stashId: string) => {
      if (!isCurrent() || active.current || picking.current) return;
      dismissError();
      let status = stateRef.current.key === key ? stateRef.current.status : undefined;
      if (!repo) {
        reportError('savedMissing');
        return;
      }
      if (!status || !status.stashes.some((stash) => stash.id === stashId)) {
        status = await refresh();
        if (!status) return;
        if (!status.stashes.some((stash) => stash.id === stashId)) {
          reportError('savedMissing');
          return;
        }
      }
      const reply = await mutate({
        action: 'restore',
        baseRepo: repo,
        stashId,
        expected: status.current,
        operationId: crypto.randomUUID(),
      });
      if (reply && !reply.blocked) toast.success(t('newChat.checkout.restored'));
    },
    [repo, key, mutate, t, refresh, reportError, dismissError, isCurrent],
  );
  actions.current = { undo, restore };
  const status = state.key === key ? state.status : undefined;
  useEffect(() => {
    const stash = status?.stashes[0];
    const identity = JSON.stringify([key, status?.current, stash?.id]);
    if (savedToast.current.identity === identity) return;
    if (savedToast.current.id) toast.dismiss(savedToast.current.id);
    savedToast.current = { identity };
    delete notices.current.saved;
    if (stash) {
      const message = t('newChat.checkout.savedChanges', { branch: stash.branch });
      const action: ToastAction = {
        label: t('newChat.checkout.restore'),
        onClick: () => {
          if (!isCurrent()) {
            toast.dismiss(id);
            return;
          }
          void actions.current.restore?.(stash.id);
        },
      };
      const id = toast.info(message, { duration: 8000, action });
      savedToast.current.id = id;
      notices.current.saved = { id, message, action };
    }
  }, [key, status, t, isCurrent]);
  useEffect(() => {
    for (const notice of Object.values(notices.current)) {
      const disabled = !!state.busy;
      if (notice.action.disabled === disabled) continue;
      notice.action = { ...notice.action, disabled };
      toast.update(notice.id, notice.message, { action: notice.action });
    }
  }, [state.busy, state.status, state.receipt]);
  return {
    ...(state.key === key ? state : { key }),
    refresh,
    pick,
    performSwitch,
    undo,
    restore,
    closeDialog: () => update({ dialog: undefined }),
    usedWorktree: () => {
      update({ dialog: undefined, error: undefined });
    },
  };
}
