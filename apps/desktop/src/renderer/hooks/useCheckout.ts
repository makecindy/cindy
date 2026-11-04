import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  CheckoutRequest,
  CheckoutReply,
  CheckoutStatus,
  CheckoutReceipt,
} from '../../shared/worktreeCheckout';

/** Presentation state is fenced by execution computer and repository, including delayed write replies. */
export function useCheckout(
  repo: string | null,
  deviceId: string | null | undefined,
  supported: boolean,
  onSourceChange: (branch: string) => void,
  source: string,
  onBusyChange?: (busy: boolean) => void,
) {
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
    previousSource?: string;
    worktreeNotice?: boolean;
  }>({ key });
  const stateRef = useRef(state);
  stateRef.current = state;
  const active = useRef(false);
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
  const refresh = useCallback(
    async (branch?: string) => {
      if (!repo || !supported || active.current) return;
      const request = ++serial.current;
      try {
        const reply = await invoke({ action: 'status', baseRepo: repo, branch });
        if ('status' in reply && currentKey.current === key && request === serial.current) {
          update({ status: reply.status, error: undefined });
          return reply.status;
        }
      } catch {
        if (request === serial.current) update({ error: 'git', status: undefined });
      }
    },
    [repo, supported, invoke, key, update],
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
        if ('pending' in reply || currentKey.current !== key) return;
        update({ status: reply.status, error: reply.blocked });
        return reply;
      } catch {
        update({ error: 'git' });
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
    [invoke, key, repo, update, onBusyChange],
  );
  const performSwitch = useCallback(
    async (branch: string, status: CheckoutStatus, strategy: 'carry' | 'stash') => {
      if (!repo) return;
      const previousSource = source || status.current;
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
      onSourceChange(branch);
      update({ dialog: undefined, receipt: reply.receipt, previousSource, worktreeNotice: false });
    },
    [repo, source, mutate, onSourceChange, update],
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
          update({ error: status.blocked });
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
    [refresh, key, update, performSwitch, onBusyChange],
  );
  const undo = useCallback(async () => {
    const previous = stateRef.current;
    if (!repo || previous.key !== key || !previous.receipt) return;
    const reply = await mutate({
      action: 'undo',
      baseRepo: repo,
      receiptId: previous.receipt.id,
      operationId: crypto.randomUUID(),
    });
    if (reply && (reply.undoApplied || !reply.blocked)) {
      onSourceChange(previous.previousSource!);
      update({ receipt: undefined });
    }
  }, [repo, key, mutate, onSourceChange, update]);
  const restore = useCallback(
    async (stashId: string) => {
      const status = stateRef.current.key === key ? stateRef.current.status : undefined;
      if (!repo || !status) return;
      await mutate({
        action: 'restore',
        baseRepo: repo,
        stashId,
        expected: status.current,
        operationId: crypto.randomUUID(),
      });
    },
    [repo, key, mutate],
  );
  return {
    ...(state.key === key ? state : { key }),
    refresh,
    pick,
    performSwitch,
    undo,
    restore,
    closeDialog: () => update({ dialog: undefined }),
    usedWorktree: () => update({ dialog: undefined, worktreeNotice: true, error: undefined }),
  };
}
