/**
 * Moving subscription accounts between providers of one kind (subscription-account-pools.md
 * 「合并与拿出由用户决定」, 2026-11-13): an account can move to another provider or out on its own,
 * and a provider can merge all its accounts into another one. Tasks keep their accounts.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowRightLeft, GitMerge } from 'lucide-react';
import type { ProviderView } from '@cindy/model-providers';
import type { SubscriptionProvider } from '../../../shared/subscriptionAccounts';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { toast } from '@/lib/toast';
import { extractIpcError } from '@/utils/ipcError';

export interface PlacementTarget {
  id: string;
  name: string;
}

/**
 * The toast for a failed placement command. A computer running a Cindy from before 2026-11-13
 * rejects these commands as invalid parameters (the UI never sends malformed ones): say it needs
 * an update instead of falling back to another operation.
 */
export function placementErrorKey(error: unknown): string {
  return extractIpcError(error)?.code === 'INVALID_PARAMS'
    ? 'subscriptionAccounts.placement.needsUpdate'
    : 'subscriptionAccounts.placement.failed';
}

/** Connected providers of the same kind an account or provider can move into (never hidden merged ones). */
export function placementTargets(
  providers: readonly ProviderView[],
  kind: SubscriptionProvider,
  excludeId: string,
): PlacementTarget[] {
  return providers
    .filter((provider) => provider.id !== excludeId && provider.connected && !provider.removed
      && !provider.subscriptionPoolAlias
      && (provider.id === kind || provider.subscriptionAccountPool === kind || provider.subscriptionPool === kind
        || (kind === 'openai' && provider.source === 'user' && provider.auth.native === 'codex')))
    .map((provider) => ({ id: provider.id, name: provider.name }));
}

export function useSubscriptionPlacementTargets(kind: SubscriptionProvider | null, excludeId: string): PlacementTarget[] {
  return useLoadedSubscriptionPlacementTargets(kind, excludeId) ?? [];
}

/** Same as above, but `null` until the provider list has been read once (a failed read counts as none). */
export function useLoadedSubscriptionPlacementTargets(
  kind: SubscriptionProvider | null,
  excludeId: string,
): PlacementTarget[] | null {
  const [providers, setProviders] = useState<ProviderView[] | null>(null);
  useEffect(() => {
    if (!kind) return;
    let current = true;
    const load = () => {
      void window.electronAPI.maker.listProviders()
        .then((scope) => { if (current) setProviders(scope.providers); })
        .catch(() => { if (current) setProviders((previous) => previous ?? []); });
    };
    load();
    const off = window.electronAPI.subscriptionAccounts.onChanged((event) => { if (event.providerId === kind) load(); });
    return () => { current = false; off(); };
  }, [kind]);
  return kind && providers ? placementTargets(providers, kind, excludeId) : null;
}

/** The account row's 「移到…」 submenu: out on its own, or into another provider of its kind. */
export function MoveAccountMenu({
  targets,
  canTakeOut,
  disabled,
  onMove,
}: {
  targets: readonly PlacementTarget[];
  canTakeOut: boolean;
  disabled?: boolean;
  onMove: (target: PlacementTarget | null) => void;
}) {
  const { t } = useTranslation();
  if (!canTakeOut && targets.length === 0) return null;
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger disabled={disabled}>
        <ArrowRightLeft size={18} className="mr-2.5" />
        {t('subscriptionAccounts.placement.moveTo')}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        {canTakeOut && (
          <DropdownMenuItem onSelect={() => onMove(null)}>
            {t('subscriptionAccounts.placement.separate')}
          </DropdownMenuItem>
        )}
        {canTakeOut && targets.length > 0 && <DropdownMenuSeparator />}
        {targets.map((target) => (
          <DropdownMenuItem key={target.id} onSelect={() => onMove(target)}>
            {target.name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

/** Confirm and move one account; the account keeps its login, history and tasks. */
export function useMoveSubscriptionAccount(providerId: string, onDone?: () => void) {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();
  return async (account: { id: string; name: string }, target: PlacementTarget | null) => {
    const ok = await confirm({
      title: target
        ? t('subscriptionAccounts.placement.moveTitle', { name: account.name, target: target.name })
        : t('subscriptionAccounts.placement.takeOutTitle', { name: account.name }),
      description: t('subscriptionAccounts.placement.moveDescription'),
      confirmText: t('subscriptionAccounts.placement.moveConfirm'),
    });
    if (!ok) return;
    try {
      await window.electronAPI.subscriptionAccounts.command({
        action: 'place', providerId, accountId: account.id, target: target?.id ?? null,
      });
      onDone?.();
    } catch (error) {
      toast.error(t(placementErrorKey(error)));
    }
  };
}

/** A provider's 「并入其他供应商…」 button: every account moves into the chosen provider. */
export function MergeProviderButton({
  kind,
  providerId,
  providerName,
  disabled,
  onDone,
}: {
  kind: SubscriptionProvider;
  providerId: string;
  providerName: string;
  disabled?: boolean;
  onDone?: () => void;
}) {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();
  const targets = useSubscriptionPlacementTargets(kind, providerId);
  if (targets.length === 0) return null;
  const merge = async (target: PlacementTarget) => {
    const ok = await confirm({
      title: t('subscriptionAccounts.placement.mergeTitle', { name: providerName, target: target.name }),
      description: t('subscriptionAccounts.placement.mergeDescription'),
      confirmText: t('subscriptionAccounts.placement.mergeConfirm'),
    });
    if (!ok) return;
    try {
      await window.electronAPI.subscriptionAccounts.command({ action: 'merge', providerId, target: target.id });
      onDone?.();
    } catch (error) {
      toast.error(t(placementErrorKey(error)));
    }
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          data-settings-search-action="Merge this provider's subscription accounts into another provider"
          variant="secondary"
          tone="quiet"
          size="sm"
          disabled={disabled}
        >
          <GitMerge size={14} />
          {t('subscriptionAccounts.placement.mergeInto')}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {targets.map((target) => (
          <DropdownMenuItem key={target.id} onSelect={() => void merge(target)}>
            {target.name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
