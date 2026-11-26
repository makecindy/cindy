/**
 * 另一台电脑上的伙伴用哪个模型(2026-11-26 用户裁决)：在「模型供应商 → 智能路由」页里点那台电脑进来，与本机同样的一页
 * (BuddyModelPanel)，读写都经那台电脑执行(`management:settings`：`models.default`、`models.setDefault`、`profile.update`)，
 * 模型从那台电脑的目录与智能路由里选，不跳到伙伴的设置页。那台是旧版本、不认识 `models.setDefault` 时默认模型只读。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { SettingsBlock, SettingsPageHeader, SettingsPageScope } from '@/components/ui/settings-rows';
import { capabilitiesFollowingDefault, capabilitiesWithModelChain } from '@/features/bots/botModelChainPatch';
import type { BotProfile } from '@/features/bots/botStore';
import { useBotTranslation } from '@/features/bots/botPronounContext';
import { useCompanionCloud } from '@/features/bots/companionCloudStore';
import { cloudRemoteBots } from '@/features/bots/companionCloudPresentation';
import { invokeBotSettings, readBotSettingsCaps } from '@/features/bots/remoteBotSettingsClient';
import { createRemoteProfileStore, type RemoteProfileStore } from '@/features/bots/remoteBotSettingsTarget';
import { useRemoteBots } from '@/features/bots/useRemoteBots';
import { toast } from '@/lib/toast';
import type { BotModelRoute } from '../../../shared/botModelChain';
import type { ModelGroupsConfig } from '../../../shared/modelGroups';
import type { BotSettingsOp } from '../../../shared/botRemoteSettings';
import { BuddyModelPanel } from './BuddyModelPanel';

interface Loaded {
  ops: ReadonlySet<BotSettingsOp>;
  defaultChain: BotModelRoute[];
  modelGroups?: ModelGroupsConfig;
  profiles: Record<string, BotProfile>;
}

export function RemoteBuddyModelsPage({ deviceId, onBack }: { deviceId: string; onBack(): void }) {
  const { t } = useBotTranslation();
  const rosterRemote = useRemoteBots();
  const cloud = useCompanionCloud();
  const bots = useMemo(() => cloudRemoteBots(cloud, rosterRemote).filter((bot) => bot.deviceId === deviceId), [cloud, rosterRemote, deviceId]);
  const deviceName = bots[0]?.deviceName ?? deviceId;
  const botIds = bots.map((bot) => bot.id).join('\u0000');
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const stores = useRef(new Map<string, RemoteProfileStore>());

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    void (async () => {
      const caps = await readBotSettingsCaps(deviceId);
      const ops = new Set(caps.ops);
      const defaults = ops.has('models.default')
        ? await invokeBotSettings<{ modelChain: BotModelRoute[]; modelGroups?: ModelGroupsConfig }>(deviceId, 'models.default', null)
        : { modelChain: [] };
      const ids = botIds ? botIds.split('\u0000') : [];
      const profiles: Record<string, BotProfile> = {};
      await Promise.all(ids.map(async (id) => {
        const store = createRemoteProfileStore(deviceId, id, ops.has('profile.acceptModelSelection'));
        stores.current.set(id, store);
        profiles[id] = await store.load().catch(() => null as never);
      }));
      if (cancelled) return;
      setLoaded({
        ops,
        defaultChain: defaults.modelChain,
        ...(defaults.modelGroups?.routes.length ? { modelGroups: defaults.modelGroups } : {}),
        profiles: Object.fromEntries(Object.entries(profiles).filter(([, profile]) => !!profile)),
      });
    })().catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [deviceId, botIds]);

  const saveFailed = useCallback(() => toast.error(t('modelGroups.buddies.saveFailed')), [t]);
  const run = async (work: () => Promise<void>) => {
    setSaving(true);
    try { await work(); } catch { saveFailed(); } finally { setSaving(false); }
  };

  return (
    <SettingsPageScope>
      <div className="flex min-w-0 flex-col" data-testid="remote-buddy-models" data-device-id={deviceId}>
        <SettingsPageHeader
          title={t('modelGroups.buddies.devicePageTitle', { device: deviceName })}
          description={t('modelGroups.buddies.devicePageHint')}
          onBack={onBack}
          backLabel={t('modelGroups.settings.back')}
        />
        <div className="mt-6 flex min-w-0 flex-col gap-3">
          {failed ? (
            <SettingsBlock className="text-13 leading-[1.5] text-[var(--text-secondary)]">{t('modelGroups.buddies.deviceUnavailable')}</SettingsBlock>
          ) : !loaded ? (
            <SettingsBlock className="text-13 leading-[1.5] text-[var(--text-tertiary)]">{t('modelGroups.buddies.deviceLoading')}</SettingsBlock>
          ) : (
            <BuddyModelPanel
              deviceId={deviceId}
              {...(loaded.modelGroups ? { hostModelGroups: loaded.modelGroups } : {})}
              disabled={saving}
              defaultChain={loaded.defaultChain}
              {...(loaded.ops.has('models.setDefault') ? {
                onDefaultChange: (chain: BotModelRoute[]) => void run(async () => {
                  const saved = await invokeBotSettings<{ modelChain: BotModelRoute[] }>(deviceId, 'models.setDefault', null, { modelChain: chain });
                  setLoaded((current) => current && { ...current, defaultChain: saved.modelChain });
                }),
              } : { defaultNote: t('modelGroups.buddies.deviceDefaultReadOnly') })}
              buddies={bots.flatMap((bot) => {
                const profile = loaded.profiles[bot.id];
                return profile ? [{ id: bot.id, name: profile.name || bot.name, avatar: bot, capabilities: profile.capabilities }] : [];
              })}
              onSetBuddy={(id, chain) => void run(async () => {
                const store = stores.current.get(id);
                const profile = loaded.profiles[id];
                if (!store || !profile) return;
                const next = chain ? capabilitiesWithModelChain(profile.capabilities, chain)
                  : capabilitiesFollowingDefault(profile.capabilities, loaded.defaultChain);
                if (!next) return;
                const saved = await store.update({ capabilities: next });
                setLoaded((current) => current && { ...current, profiles: { ...current.profiles, [id]: saved } });
              })}
            />
          )}
        </div>
      </div>
    </SettingsPageScope>
  );
}
