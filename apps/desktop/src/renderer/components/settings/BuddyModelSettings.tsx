/**
 * 「模型供应商 → 智能路由」页里的伙伴一栏(2026-11-26 用户裁决，方案 B「默认为主」)：这台电脑的伙伴默认模型，
 * 只列单独设置了模型的伙伴；其他电脑上的伙伴每台电脑一行，点进去是那台电脑同样的一页(RemoteBuddyModelsPage)，
 * 在这里改、保存到那台电脑，不跳到伙伴的设置页。伙伴的设置页里只留一行说明和入口。
 * 存下的形状与伙伴自己的设置相同(botModelChainPatch)。
 */
import { useMemo, useSyncExternalStore } from 'react';
import { useNavigate } from 'react-router-dom';

import { SettingsCard, SettingsRow, SettingsSection } from '@/components/ui/settings-rows';
import { capabilitiesFollowingDefault, capabilitiesWithModelChain } from '@/features/bots/botModelChainPatch';
import {
  isBotGlobalModelChainCustomized,
  resetBotGlobalModelChain,
  setBotGlobalModelChain,
  subscribeBotGlobalModel,
  useBotProfiles,
} from '@/features/bots/botStore';
import { useBotTranslation } from '@/features/bots/botPronounContext';
import { useCompanionCloud } from '@/features/bots/companionCloudStore';
import { cloudRemoteBots, withoutShadowedBots } from '@/features/bots/companionCloudPresentation';
import { localBotSettingsTarget } from '@/features/bots/localBotSettingsTarget';
import { useRemoteBots } from '@/features/bots/useRemoteBots';
import { toast } from '@/lib/toast';
import { BuddyModelPanel } from './BuddyModelPanel';
import { modelGroupsSettings } from './ModelGroupsSection.settings-search';

const GROUP_LABEL = 'px-1 text-12 font-medium leading-[1.33] text-[var(--text-tertiary)]';

export function BuddyModelSettings({ onOpenDevice }: { onOpenDevice?(deviceId: string): void }) {
  const { t } = useBotTranslation();
  const navigate = useNavigate();
  const profiles = useBotProfiles();
  const rosterRemote = useRemoteBots();
  const cloud = useCompanionCloud();
  // 与伙伴页同一份名册：交给别的电脑运行的本机副本不在这里改，每个云端伙伴只在它的主力电脑上列一行。
  const roster = useMemo(() => withoutShadowedBots(profiles.filter((bot) => bot.status !== 'archived'), cloud), [profiles, cloud]);
  const devices = useMemo(() => {
    const byDevice = new Map<string, { deviceId: string; name: string; count: number }>();
    for (const bot of cloudRemoteBots(cloud, rosterRemote)) {
      const entry = byDevice.get(bot.deviceId) ?? { deviceId: bot.deviceId, name: bot.deviceName, count: 0 };
      entry.count += 1;
      byDevice.set(bot.deviceId, entry);
    }
    // 按电脑名排，名册更新时顺序不跳。
    return [...byDevice.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [cloud, rosterRemote]);
  const defaultChain = localBotSettingsTarget.useDefaultModelChain();
  // 还没读到(null)时也给恢复入口，读失败不能把它藏起来。
  const defaultCustomized = useSyncExternalStore(subscribeBotGlobalModel, isBotGlobalModelChainCustomized) !== false;
  const hiddenVendors = localBotSettingsTarget.useHiddenVendors();
  const failed = () => toast.error(t('modelGroups.buddies.saveFailed'));

  return (
    <div id={modelGroupsSettings.buddies.targetId}>
      <SettingsSection title={t('modelGroups.buddies.title')} description={t('modelGroups.buddies.description')} testId="model-settings-buddies">
        <BuddyModelPanel
          defaultChain={defaultChain}
          onDefaultChange={(chain) => { void setBotGlobalModelChain(chain).catch(failed); }}
          {...(defaultCustomized ? { onDefaultRestore: () => { void resetBotGlobalModelChain().catch(failed); } } : {})}
          buddies={roster.map((bot) => ({ id: bot.id, name: bot.name, avatar: bot, capabilities: bot.capabilities }))}
          onSetBuddy={(id, chain) => {
            const bot = roster.find((item) => item.id === id);
            if (!bot) return;
            const next = chain ? capabilitiesWithModelChain(bot.capabilities, chain) : capabilitiesFollowingDefault(bot.capabilities, defaultChain);
            if (next) void localBotSettingsTarget.profile.update(bot.id, { capabilities: next }).catch(failed);
          }}
          hiddenVendors={hiddenVendors}
          onNavigateToProviders={() => navigate('/settings?tab=providers')}
        />
        {devices.length > 0 ? (
          <div className="mt-3 flex min-w-0 flex-col gap-2">
            <div className={GROUP_LABEL}>{t('modelGroups.buddies.otherComputers')}</div>
            <SettingsCard>
              {devices.map((device) => (
                <SettingsRow
                  key={device.deviceId}
                  data-remote-buddy-device={device.deviceId}
                  title={device.name}
                  hint={t('modelGroups.buddies.deviceBuddies', { count: device.count })}
                  chevron
                  {...(onOpenDevice ? { onClick: () => onOpenDevice(device.deviceId) } : {})}
                />
              ))}
            </SettingsCard>
          </div>
        ) : null}
      </SettingsSection>
    </div>
  );
}
