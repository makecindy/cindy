import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { toast } from '@/lib/toast';
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
  const actions = useRef<{
    undo?: (id: string) => Promise<void>;
    restore?: (id: string) => Promise<void>;
  }>({});
  const undoToast = useRef<string | undefined>(undefined);
  const savedToast = useRef<{ identity: string; id?: string }>({ identity: '' });
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (undoToast.current) toast.dismiss(undoToast.current);
      if (savedToast.current.id) toast.dismiss(savedToast.current.id);
      undoToast.current = undefined;
      savedToast.current = { identity: '' };
    };
  }, [key]);
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
      if (currentKey.current === key)
        setState((old) => ({ ...(old.key === key ? old : { key }), ...patch }));
    },
    [key],
  );
  const reportError = useCallback(
    (code: string, status?: CheckoutStatus, branch?: string) => {
      if (!mounted.current || currentKey.current !== key) return;
      update({ error: code });
      toast.error(formatCheckoutError(t, code, status, branch));
    },
    [key, t, update],
  );
  const refresh = useCallback(
    async (branch?: string) => {
      if (!repo || !supported || active.current) return;
      const request = ++serial.current;
      try {
        const reply = await invoke({ action: 'status', baseRepo: repo, branch });
        if (
          'status' in reply &&
          mounted.current &&
          currentKey.current === key &&
          request === serial.current
        ) {
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
    [repo, supported, invoke, key, update, reportError],
  );
  useEffect(() => {
    void refresh();
    const focus = () => {
      void refresh();
    };
    window.addEventListener('focus', focus);
    return () => window.removeEventListener('focus', focus);
  }, [refresh]);
  const mutate = useCallback(
    async (req: CheckoutRequest) => {
      if (active.current) return;
      active.current = true;
      onBusyChange?.(true);
      ++serial.current;
      update({ busy: true, error: undefined });
      try {
        let reply: CheckoutReply | undefined;
        try {
          reply = await invoke(req);
          while ('pending' in reply && currentKey.current === key)
            reply = await invoke({
              action: 'result',
              baseRepo: repo!,
              operationId: reply.operationId,
            });
        } catch (error) {
          // The write may already be committed. Recover its receipt, never replay it.
          for (let attempt = 0; attempt < 2 && currentKey.current === key; attempt++) {
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
        if ('pending' in reply || currentKey.current !== key || !mounted.current) return;
        update({ status: reply.status, error: reply.blocked });
        if (reply.blocked)
          reportError(
            reply.blocked,
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
        if (currentKey.current === key) {
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
    [invoke, key, repo, update, onBusyChange, reportError],
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
        undoToast.current = toast.success(message, {
          duration: 8000,
          action: {
            label: t('newChat.checkout.undo'),
            onClick: () => {
              if (mounted.current && currentKey.current === key)
                void actions.current.undo?.(receipt.id);
            },
          },
        });
      }
    },
    [repo, mutate, update, key, t],
  );
  const picking = useRef(false);
  const pick = useCallback(
    async (branch: string) => {
      if (picking.current || active.current) return;
      picking.current = true;
      onBusyChange?.(true);
      update({ busy: true });
      try {
        const status = await refresh(branch);
        if (!status || currentKey.current !== key) return;
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
    [refresh, key, update, performSwitch, onBusyChange, reportError],
  );
  const undo = useCallback(
    async (expectedReceiptId?: string) => {
      const previous = stateRef.current;
      if (
        !repo ||
        previous.key !== key ||
        !previous.receipt ||
        (expectedReceiptId && previous.receipt.id !== expectedReceiptId)
      )
        return;
      const reply = await mutate({
        action: 'undo',
        baseRepo: repo,
        receiptId: previous.receipt.id,
        operationId: crypto.randomUUID(),
      });
      if (reply && (reply.undoApplied || !reply.blocked)) {
        update({ receipt: undefined });
        if (undoToast.current) toast.dismiss(undoToast.current);
        undoToast.current = undefined;
        if (!reply.blocked) toast.success(t('newChat.checkout.undone'));
      }
    },
    [repo, key, mutate, update, t],
  );
  const restore = useCallback(
    async (stashId: string) => {
      const status = stateRef.current.key === key ? stateRef.current.status : undefined;
      if (!repo || !status || !status.stashes.some((stash) => stash.id === stashId)) return;
      const reply = await mutate({
        action: 'restore',
        baseRepo: repo,
        stashId,
        expected: status.current,
        operationId: crypto.randomUUID(),
      });
      if (reply && !reply.blocked) toast.success(t('newChat.checkout.restored'));
    },
    [repo, key, mutate, t],
  );
  actions.current = { undo, restore };
  const status = state.key === key ? state.status : undefined;
  useEffect(() => {
    const stash = status?.stashes[0];
    const identity = JSON.stringify([key, status?.current, stash?.id]);
    if (savedToast.current.identity === identity) return;
    if (savedToast.current.id) toast.dismiss(savedToast.current.id);
    savedToast.current = { identity };
    if (stash)
      savedToast.current.id = toast.info(
        t('newChat.checkout.savedChanges', { branch: stash.branch }),
        {
          duration: 8000,
          action: {
            label: t('newChat.checkout.restore'),
            onClick: () => {
              if (mounted.current && currentKey.current === key)
                void actions.current.restore?.(stash.id);
            },
          },
        },
      );
  }, [key, status, t]);
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
