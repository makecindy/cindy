import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { sessionAccountDisplay, useSessionSubscriptionAccount } from './SessionSubscriptionAccount';
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
import type {
  SubscriptionAccountUsage,
  SubscriptionProvider,
  SubscriptionPoolView,
} from '../../../shared/subscriptionAccounts';
import { isDeviceLinkRemotePushCurrent } from '@/lib/remoteDataOwnerPushFence';
import {
  selectableSubscriptionAccount,
  subscriptionQuotaAccounts,
} from '@cindy/maker-shared/subscription-selection';

export interface ModelPickerAccountInfo {
  identity?: string;
  plan?: string | null;
  usage: SubscriptionAccountUsage | null;
}
interface ModelPickerAccount extends ModelPickerAccountInfo {
  /** Available quota snapshots, without claiming any account was allocated. */
  members?: ModelPickerAccountInfo[];
}

// Unknown/ambiguous selection must not fall back to the CLI default account.
const UNASSIGNED: ModelPickerAccount = { usage: null };
type Accounts = Partial<Record<SubscriptionProvider, ModelPickerAccount | null>>;
// A remote favorite and its rail can mount together. Share only the in-flight
// read, scoped by owner/device/task; completed reads are never cached here.
const accountFlights = new Map<
  string,
  Promise<readonly [SubscriptionProvider, ModelPickerAccount | null]>
>();
const Context = createContext<{ deviceId: string | null; accounts: Accounts; enabled: boolean }>({
  deviceId: null,
  accounts: {},
  enabled: false,
});

/** Shared account presentation for every picker entry; never changes execution bindings. */
export function ModelPickerAccountProvider({
  enabled,
  deviceId,
  children,
  providerIds,
  taskId,
}: {
  enabled: boolean;
  deviceId: string | null;
  providerIds: SubscriptionProvider[];
  taskId?: string;
  children: ReactNode;
}) {
  return enabled && providerIds.length > 0 ? (
    <ScopedModelPickerAccount providerIds={providerIds} deviceId={deviceId} taskId={taskId}>
      {children}
    </ScopedModelPickerAccount>
  ) : (
    <Context.Provider value={{ deviceId, accounts: {}, enabled }}>{children}</Context.Provider>
  );
}

function ScopedModelPickerAccount({
  children,
  providerIds,
  taskId,
  deviceId,
}: {
  children: ReactNode;
  providerIds: SubscriptionProvider[];
  taskId?: string;
  deviceId: string | null;
}) {
  const providersKey = JSON.stringify([deviceId, providerIds, taskId]);
  const user = useOptionalAuthUser();
  const ownerGeneration = useOptionalDataOwnerGeneration();
  const [result, setResult] = useState<{
    owner: DataOwnerGeneration;
    key: string;
    preview: Partial<Record<SubscriptionProvider, ModelPickerAccount | null>>;
  } | null>(null);
  useEffect(() => {
    // Clear only when the owner/directory/task scope changes. Background refreshes
    // keep the last complete view until the next snapshot is ready; the render
    // guard below prevents a previous scope from being displayed in the meantime.
    setResult(null);
    let epoch = 0;
    let pending = false;
    let queued = false;
    let disposed = false;
    const refresh = async () => {
      const current = ++epoch;
      if (pending) {
        queued = true;
        return;
      }
      pending = true;
      const owner = getDataOwnerGeneration();
      try {
        const entries = await Promise.all(
          providerIds.map(async (providerId) => {
            const flightKey = JSON.stringify([owner, deviceId, providerId, taskId]);
            const existing = accountFlights.get(flightKey);
            if (existing) return existing;
            const flight = (async () => {
              try {
                const command = (action: 'preview' | 'read'): Promise<SubscriptionPoolView> =>
                  deviceId === null
                    ? window.electronAPI.subscriptionAccounts.command({
                        action,
                        providerId,
                        ...(action === 'read' && taskId ? { taskId } : {}),
                      })
                    : window.electronAPI.deviceLink
                        .invoke(deviceId, 'maker:subscription-accounts', [
                          {
                            action,
                            providerId,
                            ...(action === 'read' && taskId ? { taskId } : {}),
                          },
                        ])
                        .then((value) => value as SubscriptionPoolView);
                const preview = await command('preview');
                if (preview.providerId !== providerId) return [providerId, UNASSIGNED] as const;
                if (!preview.configured) return [providerId, null] as const;
                const pool = await command('read');
                if (pool.providerId !== providerId) return [providerId, UNASSIGNED] as const;
                const account = selectableSubscriptionAccount(pool, !!taskId);
                const members = subscriptionQuotaAccounts(pool);
                return [
                  providerId,
                  account === undefined
                    ? null
                    : account && (pool.boundAccountId || members.length <= 1)
                      ? {
                          identity: account.identity?.trim() || undefined,
                          plan: account.plan,
                          usage: account.usage ?? null,
                        }
                      : {
                          ...UNASSIGNED,
                          members: members.map((member) => ({
                            identity: member.identity?.trim() || undefined,
                            plan: member.plan,
                            usage: member.usage ?? null,
                          })),
                        },
                ] as const;
              } catch (error) {
                if (String(error).includes("channel 'maker:subscription-accounts' not allowed remotely"))
                  return [providerId, null] as const;
                return [providerId, UNASSIGNED] as const;
              }
            })();
            accountFlights.set(flightKey, flight);
            try {
              return await flight;
            } finally {
              if (accountFlights.get(flightKey) === flight) accountFlights.delete(flightKey);
            }
          }),
        );
        if (current !== epoch || !isDataOwnerGenerationCurrent(owner)) return;
        setResult({ owner, key: providersKey, preview: Object.fromEntries(entries) });
      } finally {
        pending = false;
        if (queued && !disposed) {
          queued = false;
          void refresh();
        }
      }
    };
    const unsubscribe =
      deviceId === null
        ? window.electronAPI?.subscriptionAccounts?.onChanged?.((event) => {
            if (providerIds.includes(event.providerId)) void refresh();
          })
        : window.electronAPI?.deviceLink?.onRemotePush?.((push, stamp) => {
            if (
              push.deviceId === deviceId &&
              isDeviceLinkRemotePushCurrent(push, stamp) &&
              push.channel === 'subscription-accounts:changed'
            )
              void refresh();
          });
    const focus = () => {
      void refresh();
    };
    window.addEventListener('focus', focus);
    void refresh();
    return () => {
      disposed = true;
      ++epoch;
      unsubscribe?.();
      window.removeEventListener('focus', focus);
    };
  }, [user?.id, ownerGeneration, providersKey]);
  const preview =
    result && result.key === providersKey && isDataOwnerGenerationCurrent(result.owner)
      ? result.preview
      : Object.fromEntries(providerIds.map((id) => [id, UNASSIGNED]));
  return (
    <Context.Provider value={{ deviceId, accounts: preview, enabled: true }}>
      {children}
    </Context.Provider>
  );
}

export function useModelPickerAccount(providerId: string, deviceId?: string | null): ModelPickerAccount | null {
  const preview = useContext(Context);
  const selfDeviceId = useOptionalAuthDeviceId();
  const { t } = useTranslation();
  const target = deviceId === selfDeviceId ? null : deviceId;
  // The task's executing computer knows its native-session binding. Its answer
  // takes precedence over picker previews, including a group's next pool pick.
  const session = useSessionSubscriptionAccount(
    providerId,
    target === undefined ? preview.deviceId : target,
  );
  const display = preview.enabled ? sessionAccountDisplay(session, t) : null;
  if (display) {
    return {
      ...(display.identity ? { identity: display.identity } : {}),
      plan: display.plan,
      usage: session?.state === 'bound' ? session.account.usage ?? null : display.usage,
    };
  }
  return (providerId === 'anthropic' || providerId === 'openai') &&
    (target === undefined || target === preview.deviceId)
    ? (preview.accounts[providerId] ?? null)
    : null;
}

/** A rail can show several computers while the main list shows only one directory. */
export function ModelPickerAccountBoundary({
  providerId,
  deviceId,
  children,
}: {
  providerId: string;
  deviceId: string | null;
  children: ReactNode;
}) {
  const parent = useContext(Context);
  const selfDeviceId = useOptionalAuthDeviceId();
  const target = deviceId === selfDeviceId ? null : deviceId;
  if (
    !parent.enabled ||
    (providerId !== 'anthropic' && providerId !== 'openai') ||
    (parent.deviceId === target && providerId in parent.accounts)
  )
    return children;
  return (
    <ModelPickerAccountProvider enabled deviceId={target} providerIds={[providerId]}>
      {children}
    </ModelPickerAccountProvider>
  );
}
