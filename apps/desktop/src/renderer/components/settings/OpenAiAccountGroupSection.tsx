import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { ArrowDown, ArrowUp, GripVertical } from 'lucide-react';
import { SortableList } from '@/components/sidebar/SortableList';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import { toast } from '@/lib/toast';
import { extractIpcError } from '@/utils/ipcError';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent, subscribeDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { ProviderGroupLimitSelect, ProviderGroupWeightSelect } from '@/features/provider-group/ProviderGroupAllocationControls';
import { providerManagementErrorKey } from '@/features/provider-group/providerManagement';
import type { OpenAiGroupAccount, OpenAiGroupAccountDetail, OpenAiGroupApiAgent, OpenAiGroupProbeResult } from '../../../shared/openAiAccountGroup';
import { withLocalProviderGroupAccounts, type ProviderGroupAccountAllocation } from '../../../shared/providerGroup';
import type { SubscriptionAccountView } from '../../../shared/subscriptionAccounts';
import { providersSettings } from './ProvidersSection.settings-search';
import { RouteStrategyNote } from './RouteStrategyNote';
import { useSettingDefinition } from './useSettingDefinition';
import { QuotaHoverCard } from '../status/QuotaHoverCard';
import { buildSubscriptionAccountUsageCard } from '../status/usageCardModel';

function SubscriptionQuota({ providerId, accountId }: { providerId: string; accountId: string }) {
  const { t, i18n } = useTranslation();
  const [accounts, setAccounts] = useState<Pick<SubscriptionAccountView, 'id' | 'identity' | 'usage'>[]>();
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const generation = useRef(0);
  useEffect(() => {
    const current = ++generation.current;
    void window.electronAPI.subscriptionAccounts.command({ action: 'read', providerId: accountId }).then(next => {
      if (generation.current === current) setAccounts(next.accounts);
    }).catch(() => {});
    return () => { ++generation.current; };
  }, [accountId]);
  const refresh = () => {
    if (inFlight.current) return;
    inFlight.current = true;
    const current = generation.current;
    setBusy(true);
    void window.electronAPI.providerGroup.command({ action: 'account-quota', providerId, accountId }).then(next => {
      if (generation.current === current) setAccounts(next);
    }).catch(() => {
      if (generation.current === current) setAccounts(undefined);
    }).finally(() => {
      inFlight.current = false;
      if (generation.current === current) setBusy(false);
    });
  };
  return <div className="space-y-2">
    {accounts?.length ? accounts.map(account => {
      const card = buildSubscriptionAccountUsageCard(account.usage, t, Date.now(), i18n.language);
      return <div key={account.id}>
        {account.identity && <p className="break-words text-12 text-[var(--text-secondary)]">{account.identity}</p>}
        {card?.windows.length
          ? <QuotaHoverCard account={card} variant="embedded" hideIdentity />
          : <p className="text-12 text-[var(--text-secondary)]">{t('subscriptionAccounts.unavailable')}</p>}
      </div>;
    }) : <p className="text-12 text-[var(--text-secondary)]">{t('subscriptionAccounts.unavailable')}</p>}
    <Button data-settings-search-action="Refresh this subscription account's current quota" variant="secondary" size="sm" disabled={busy} onClick={refresh}>{t('openAiAccountGroup.refresh')}</Button>
  </div>;
}

export function openAiGroupFailureKey(code: OpenAiGroupProbeResult['code']): string {
  if (code === 'MODEL_NOT_FOUND') return 'openAiAccountGroup.modelUnavailable';
  if (code === 'NO_TEST_MODEL') return 'openAiAccountGroup.noTestModel';
  return `providerError.${code ?? 'UNKNOWN'}`;
}

export function useOpenAiAccountGroup(providerId: string | undefined) {
  const [snapshot, setSnapshot] = useState<{ id: string; owner: ReturnType<typeof getDataOwnerGeneration>;
    detail?: OpenAiGroupAccountDetail; loading: boolean; failed: boolean }>();
  const generation = useRef(0);
  const active = useRef<string | undefined>(undefined);
  const refresh = useCallback(() => {
    if (!providerId || active.current !== providerId) return;
    const current = ++generation.current;
    const owner = getDataOwnerGeneration();
    const detailFor = (previous: typeof snapshot) =>
      previous?.id === providerId && previous.owner === owner ? previous.detail : undefined;
    const currentRead = () => generation.current === current && isDataOwnerGenerationCurrent(owner);
    setSnapshot(previous => ({ id: providerId, owner, detail: detailFor(previous), loading: true, failed: false }));
    void window.electronAPI.providerGroup.command({ action: 'account-detail', providerId }).then(next => {
      if (currentRead()) setSnapshot({ id: providerId, owner, detail: next, loading: false, failed: false });
    }).catch(() => {
      if (currentRead()) setSnapshot(previous => ({ id: providerId, owner, detail: detailFor(previous), loading: false, failed: true }));
    });
  }, [providerId]);
  useEffect(() => {
    if (!providerId) return;
    active.current = providerId;
    refresh();
    const offGroup = window.electronAPI.providerGroup.onChanged?.(refresh);
    const offProviders = window.electronAPI.maker?.onProvidersChanged?.(refresh);
    const offSubscriptions = window.electronAPI.subscriptionAccounts?.onChanged?.(refresh);
    const offOwner = subscribeDataOwnerGeneration(refresh);
    return () => {
      ++generation.current;
      active.current = undefined;
      offGroup?.();
      offProviders?.();
      offSubscriptions?.();
      offOwner();
    };
  }, [providerId, refresh]);
  const current = snapshot && snapshot.id === providerId && snapshot.owner === getDataOwnerGeneration() ? snapshot : undefined;
  return { accounts: current?.detail?.accounts, allocation: current?.detail?.group, targets: current?.detail?.targets,
    readFailed: current?.failed ?? false, loading: current?.loading ?? Boolean(providerId), refresh };
}

export function OpenAiAccountGroupSection({ providerId, group, mergeAction, settingsAnchor = true }: {
  providerId: string;
  group: ReturnType<typeof useOpenAiAccountGroup>;
  mergeAction?: ReactNode;
  settingsAnchor?: boolean;
}) {
  const accountSetting = useSettingDefinition(providersSettings.subscriptionAccounts);
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();
  const { accounts, allocation, targets, readFailed, loading, refresh } = group;
  const reducedMotion = useReducedMotion();
  const groupProviderId = allocation?.providerId ?? providerId;
  const mixedConfig = allocation?.config;
  const localMembers = mixedConfig ? withLocalProviderGroupAccounts(mixedConfig, groupProviderId).members
    .filter(member => member.kind === 'local') : [];
  const localSettings = new Map(localMembers.map(member => [member.providerId, member]));
  const [saving, setSaving] = useState(false);
  const allocationInFlight = useRef(false);
  const [probeResults, setProbeResults] = useState<Record<string, OpenAiGroupProbeResult>>({});
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const operations = useRef(new Set<string>());
  const run = async (action: 'account-test' | 'account-remove', id: string, agent?: OpenAiGroupApiAgent) => {
    const key = agent ? `${id}:${agent}` : id;
    if (operations.current.has(key)) return;
    const owner = getDataOwnerGeneration();
    operations.current.add(key);
    setBusy(new Set(operations.current));
    try {
      const result = await window.electronAPI.providerGroup.command(action === 'account-test'
        ? { action, providerId: groupProviderId, accountId: id, agent }
        : { action, providerId: groupProviderId, accountId: id });
      if (isDataOwnerGenerationCurrent(owner)) {
        if (action === 'account-test') setProbeResults(previous => ({ ...previous, [key]: result }));
        refresh();
      }
    } catch (error) {
      if (isDataOwnerGenerationCurrent(owner)) toast.error(t(providerManagementErrorKey(error, false)));
    } finally {
      operations.current.delete(key);
      setBusy(new Set(operations.current));
    }
  };
  const remove = async (account: OpenAiGroupAccount) => {
    const owner = getDataOwnerGeneration();
    const confirmed = await confirm({
      title: t('providerGroup.member.removeConfirm.title', { name: account.name }),
      description: t('openAiAccountGroup.removeDescription'),
      confirmText: t('providerGroup.member.removeConfirm.confirm'),
      confirmVariant: 'destructive',
    });
    if (confirmed && isDataOwnerGenerationCurrent(owner)) await run('account-remove', account.id);
  };
  const resultLabel = (result: OpenAiGroupProbeResult) => result.ok ? t('openAiAccountGroup.testPassed') : t(openAiGroupFailureKey(result.code));
  const accountById = new Map((allocation?.members ?? accounts?.filter(account => account.included))
    ?.map(account => [account.id, account]));
  const membership = mixedConfig ? localMembers.flatMap(member => {
    const account = accountById.get(member.providerId);
    return account ? [account] : [];
  }) : [...accountById.values()];
  const blocked = saving || loading || readFailed;
  const ordered = mixedConfig?.strategy === 'order' && membership.length === localMembers.length;
  const saveAllocation = async (edit: ProviderGroupAccountAllocation) => {
    if (!mixedConfig || blocked || allocationInFlight.current) return;
    const owner = getDataOwnerGeneration();
    allocationInFlight.current = true;
    setSaving(true);
    try {
      await window.electronAPI.providerGroup.command({
        action: 'account-allocation', providerId: groupProviderId, expectedConfig: mixedConfig, edit,
      });
    } catch (error) {
      if (!isDataOwnerGenerationCurrent(owner)) return;
      if (extractIpcError(error)?.code === 'PROVIDER_GROUP_CHANGED') refresh();
      toast.error(t(providerManagementErrorKey(error, false)));
    } finally {
      allocationInFlight.current = false;
      setSaving(false);
    }
  };
  const move = (index: number, target: number) => {
    const order = membership.map(row => row.id);
    [order[index], order[target]] = [order[target]!, order[index]!];
    void saveAllocation({ order });
  };
  const renderAccount = (account: OpenAiGroupAccount, index: number) => {
    const settings = localSettings.get(account.id);
    const checks = account.checks ?? [];
    const pending = busy.has(account.id) || checks.some(check => busy.has(`${account.id}:${check.agent}`));
    const showQuota = account.kind === 'subscription' && account.id !== providerId;
    const engineName = (agent: OpenAiGroupApiAgent) => agent === 'codex' ? 'Codex' : 'Pi';
    return <div key={account.id} className="flex flex-col gap-2 py-3" data-testid="openai-group-account">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {mixedConfig && <div className="flex min-w-0 items-center gap-2">
          {ordered && <span data-account-drag className="touch-none text-[var(--text-tertiary)]" aria-hidden="true"><GripVertical size={16} /></span>}
          <div className="min-w-0 space-y-1">
            <div className="break-words text-13 font-medium">{account.name}</div>
            <div className="text-12 text-[var(--text-secondary)]">{t(account.kind === 'apiKey' ? 'settings.providers.custom.authMode.apiKey' : 'subscriptionAccounts.title')}</div>
            {settings?.paused && <div className="text-12 text-[var(--text-secondary)]">{t('providerGroup.member.status.paused')}</div>}
          </div>
        </div>}
        <div className="ml-auto flex max-w-full flex-wrap items-center justify-end gap-2">
          {settings && <ProviderGroupLimitSelect name={account.name} member={settings} disabled={blocked} compact
            onChange={limit => void saveAllocation({ accountId: account.id, limit })} />}
          {mixedConfig?.strategy === 'weighted' && settings &&
            <ProviderGroupWeightSelect name={account.name} weight={settings.weight} disabled={blocked}
              onChange={next => void saveAllocation({ accountId: account.id, weight: next })} />}
          {settings && <Switch {...accountSetting.controlProps} checked={!settings.paused} disabled={blocked}
            aria-label={t('providerGroup.member.assignAria', { name: account.name })}
            onCheckedChange={checked => void saveAllocation({ accountId: account.id, paused: !checked })} />}
          {ordered && <>
            <Button {...accountSetting.controlProps} variant="secondary" tone="quiet" compact size="sm" aria-label={t('modelGroups.settings.moveUp')}
              disabled={blocked || index === 0} onClick={() => move(index, index - 1)}><ArrowUp size={15} /></Button>
            <Button {...accountSetting.controlProps} variant="secondary" tone="quiet" compact size="sm" aria-label={t('modelGroups.settings.moveDown')}
              disabled={blocked || index === membership.length - 1} onClick={() => move(index, index + 1)}><ArrowDown size={15} /></Button>
          </>}
          {(checks.length > 0 || account.id !== groupProviderId) && (
            <div data-testid="openai-group-account-actions" className="flex shrink-0 items-center gap-1.5">
              {checks.map(check => {
                const testing = busy.has(`${account.id}:${check.agent}`);
                const engine = engineName(check.agent);
                const test = t('settings.providers.custom.test.button');
                const label = checks.length > 1 ? `${test} · ${engine}` : test;
                return <Button key={check.agent} data-settings-search-action="Test this API key connection on the selected engine" variant="secondary" size="sm"
                  compact={checks.length > 1} loading={testing} aria-label={`${label} · ${account.name}`}
                  disabled={loading || readFailed || !account.connected || testing || busy.has(account.id)}
                  onClick={() => void run('account-test', account.id, check.agent)}>
                  {label}
                </Button>;
              })}
              {account.id !== groupProviderId && <Button data-settings-search-action="Remove this account from its current provider group" variant="secondary" size="sm" compact={checks.length > 1}
                disabled={pending || blocked} onClick={() => void remove(account)}>
                {t('providerGroup.member.remove')}
              </Button>}
            </div>
          )}
        </div>
      </div>
      {showQuota && <SubscriptionQuota providerId={groupProviderId} accountId={account.id} />}
      {checks.map(check => {
        const testing = busy.has(`${account.id}:${check.agent}`);
        const billing = check.blocked && check.result?.code === 'QUOTA_EXCEEDED';
        const observed = check.result ?? probeResults[`${account.id}:${check.agent}`];
        const result = testing ? t('settings.providers.custom.test.testing')
          : billing ? t('openAiAccountGroup.billingPaused') : observed ? resultLabel(observed) : undefined;
        return result ? <p key={check.agent} role="status" className={observed?.ok === false && !testing
          ? 'text-12 text-[var(--text-danger)]' : 'text-12 text-[var(--text-secondary)]'}>
          {checks.length > 1 && <span className="mr-2">{engineName(check.agent)}</span>}{result}
        </p> : null;
      })}
    </div>;
  };
  const standaloneKey = !mixedConfig ? membership.find(account => account.id === providerId && account.kind === 'apiKey') : undefined;
  if (!mixedConfig && !standaloneKey && !readFailed && !loading && !targets?.length) return null;
  return (
    <section {...(settingsAnchor ? accountSetting.anchorProps : {})} data-testid="openai-account-group" className="border-t border-[var(--border-default)] px-5 py-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {mixedConfig && <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-16 font-medium text-[var(--text-primary)]">{t('openAiAccountGroup.title')}</h3>
          <span className="text-12 text-[var(--text-tertiary)]">{membership.length}</span>
        </div>}
        {mergeAction}
        {standaloneKey && renderAccount(standaloneKey, 0)}
      </div>
      {readFailed && <div role="alert" className="my-2 flex flex-wrap items-center gap-2 text-13 text-[var(--text-secondary)]">
        {t('providerGroup.section.loadFailed')}
        <Button data-settings-search-action="Retry loading this provider's account group" variant="secondary" size="sm" onClick={refresh}>{t('commonUi.retry')}</Button>
      </div>}
      {loading && !accounts && <p role="status" className="my-2 text-13 text-[var(--text-secondary)]">{t('providerGroup.section.loading')}</p>}
      {targets && <div className="flex flex-wrap gap-x-3 gap-y-1 py-2">
        {targets.map(target => <Link key={target.id} className="text-13 text-[var(--text-primary)] underline"
          to={`/settings?tab=providers&connect=${encodeURIComponent(target.id)}`}>{target.name}</Link>)}
      </div>}
      {/* 这几个账号怎么分与别的账号池一样只在「智能路由」里改：这里说明现状并给出入口(每个账号的并发、权重、开关与先后仍在下面)。 */}
      {mixedConfig && <RouteStrategyNote strategy={mixedConfig.strategy} providerId={groupProviderId} />}
      {mixedConfig && (ordered
        ? <SortableList items={membership} getId={account => account.id} renderItem={renderAccount}
            disabled={blocked} reducedMotion={reducedMotion} handle="[data-account-drag]"
            onReorder={order => void saveAllocation({ order })} className="divide-y divide-[var(--border-default)]" />
        : <div className="divide-y divide-[var(--border-default)]">{membership.map(renderAccount)}</div>)}
    </section>
  );
}
