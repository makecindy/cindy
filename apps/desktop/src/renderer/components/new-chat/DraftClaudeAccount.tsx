import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import {
  useOptionalAuthDeviceId,
  useOptionalAuthUser,
  useOptionalDataOwnerGeneration,
} from '@/contexts/AuthContext';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
  type DataOwnerGeneration,
} from '@/contexts/dataOwnerGeneration';
import type { ClaudeSubscriptionUsageSnapshot } from '../../../shared/claudeSubscriptionUsage';

interface DraftClaudeAccount {
  identity?: string;
  plan?: string | null;
  usage: ClaudeSubscriptionUsageSnapshot | null;
}

// Unknown/ambiguous selection must not fall back to the CLI default account.
const UNASSIGNED: DraftClaudeAccount = { usage: null };
const Context = createContext<DraftClaudeAccount | null>(null);

/** Local, new-task menu only. This is a display preview, never an account binding. */
export function DraftClaudeAccountProvider({
  enabled,
  children,
}: {
  enabled: boolean;
  children: ReactNode;
}) {
  return enabled ? (
    <LocalDraftClaudeAccount>{children}</LocalDraftClaudeAccount>
  ) : (
    <Context.Provider value={null}>{children}</Context.Provider>
  );
}

function LocalDraftClaudeAccount({ children }: { children: ReactNode }) {
  const user = useOptionalAuthUser();
  const ownerGeneration = useOptionalDataOwnerGeneration();
  const [result, setResult] = useState<{
    owner: DataOwnerGeneration;
    preview: DraftClaudeAccount | null;
  } | null>(null);
  useEffect(() => {
    let epoch = 0;
    const refresh = async () => {
      const current = ++epoch;
      const owner = getDataOwnerGeneration();
      setResult(null);
      try {
        // The existing preview probes the default login without fetching quota.
        // An unconfigured pool must not delay the legacy reader on a CLI usage call.
        const preview = await window.electronAPI.subscriptionAccounts.command({
          action: 'preview',
          providerId: 'anthropic',
        });
        if (current !== epoch || !isDataOwnerGenerationCurrent(owner)) return;
        if (preview.providerId !== 'anthropic') return;
        if (!preview.configured) {
          setResult({ owner, preview: null });
          return;
        }
        // Preview can detect an unbound default login; only the authorized read
        // may supply the assignable account's identity, plan and usage.
        const pool = await window.electronAPI.subscriptionAccounts.command({
          action: 'read',
          providerId: 'anthropic',
        });
        if (current !== epoch || !isDataOwnerGenerationCurrent(owner)) return;
        if (pool.providerId !== 'anthropic') return;
        const available = pool.accounts.filter(
          (account) =>
            !account.paused && account.status === 'ready' && account.running < account.limit,
        );
        const account = available.length === 1 ? available[0] : undefined;
        setResult({
          owner,
          preview: !pool.configured
            ? null
            : account?.identity?.trim()
              ? {
                  identity: account.identity.trim(),
                  plan: account.plan ?? account.usage?.claude?.subscriptionType,
                  usage: account.usage?.claude ?? null,
                }
              : UNASSIGNED,
        });
      } catch {
        // Unavailable pool information is not evidence that the default is assignable.
      }
    };
    const unsubscribe = window.electronAPI.subscriptionAccounts?.onChanged((event) => {
      if (event.providerId === 'anthropic') void refresh();
    });
    const focus = () => {
      void refresh();
    };
    window.addEventListener('focus', focus);
    void refresh();
    return () => {
      ++epoch;
      unsubscribe?.();
      window.removeEventListener('focus', focus);
    };
  }, [user?.id, ownerGeneration]);
  const preview =
    result && isDataOwnerGenerationCurrent(result.owner) ? result.preview : UNASSIGNED;
  return <Context.Provider value={preview}>{children}</Context.Provider>;
}

export function useDraftClaudeAccount(providerId: string, deviceId: string | null = null) {
  const preview = useContext(Context);
  const selfDeviceId = useOptionalAuthDeviceId();
  return providerId === 'anthropic' && (deviceId === null || deviceId === selfDeviceId)
    ? preview
    : null;
}
