/**
 * 「模型供应商 → 智能路由」页里的伙伴一栏：这台电脑上每位伙伴用哪个模型、备用哪几个，直接在这里改(2026-11-26 用户反馈：
 * 原来只有一个入口跳去伙伴页)。编辑器与存下的形状都和伙伴自己的「模型」页同一份(BotModelChainEditor、botModelChainPatch)，
 * 两处改的是同一个设置。伙伴的其余设置仍在伙伴页。另一台电脑上的伙伴各占一行、点开到它的设置：它们的模型在那台的目录里选。
 */
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { SettingsCard, SettingsRow, SettingsSection } from '@/components/ui/settings-rows';
import { useRemoteBots } from '@/features/bots/useRemoteBots';
import { toast } from '@/lib/toast';
import { BotModelChainEditor } from '@/features/bots/BotModelChainEditor';
import { capabilitiesFollowingDefault, capabilitiesWithModelChain, displayedModelChain } from '@/features/bots/botModelChainPatch';
import { useBotProfiles, type BotCapabilities, type BotProfile } from '@/features/bots/botStore';
import { useBotTranslation } from '@/features/bots/botPronounContext';
import { localBotSettingsTarget } from '@/features/bots/localBotSettingsTarget';
import type { BotModelRoute } from '../../../shared/botModelChain';

export function BuddyModelSettings() {
  const { t } = useBotTranslation();
  const navigate = useNavigate();
  const roster = useBotProfiles().filter((bot) => bot.status !== 'archived');
  const defaultChain = localBotSettingsTarget.useDefaultModelChain();
  const hiddenVendors = localBotSettingsTarget.useHiddenVendors();
  const remote = useRemoteBots();
  if (roster.length === 0 && remote.length === 0) return null;
  return (
    <SettingsSection title={t('modelGroups.buddies.title')} description={t('modelGroups.buddies.description')} testId="model-settings-buddies">
      {roster.map((bot) => (
        <BuddyModelCard key={bot.id} bot={bot} defaultChain={defaultChain} hiddenVendors={hiddenVendors}
          onNavigateToProviders={() => navigate('/settings?tab=providers')} />
      ))}
      {remote.length > 0 ? (
        <SettingsCard>
          {remote.map((bot) => (
            <SettingsRow key={`${bot.deviceId}\u0000${bot.id}`} data-remote-buddy-model={bot.id} title={bot.name}
              hint={t('modelGroups.buddies.remoteHint', { device: bot.deviceName })} chevron
              onClick={() => navigate(`/bots/remote/${encodeURIComponent(bot.deviceId)}/${encodeURIComponent(bot.id)}`)} />
          ))}
        </SettingsCard>
      ) : null}
    </SettingsSection>
  );
}

function BuddyModelCard({ bot, defaultChain, hiddenVendors, onNavigateToProviders }: {
  bot: BotProfile;
  defaultChain: BotModelRoute[];
  hiddenVendors: ReturnType<typeof localBotSettingsTarget.useHiddenVendors>;
  onNavigateToProviders: () => void;
}) {
  const { t } = useBotTranslation();
  // 先显示改后的样子，存失败再退回；伙伴页那边改了(档案更新)就跟着换。
  const [capabilities, setCapabilities] = useState<BotCapabilities>(bot.capabilities);
  const saved = useRef(bot.capabilities);
  useEffect(() => {
    saved.current = bot.capabilities;
    setCapabilities(bot.capabilities);
  }, [bot.capabilities]);
  const save = (next: BotCapabilities) => {
    setCapabilities(next);
    void localBotSettingsTarget.profile.update(bot.id, { capabilities: next }).catch(() => {
      setCapabilities(saved.current);
      toast.error(t('modelGroups.buddies.saveFailed'));
    });
  };
  const following = capabilities.modelChainOverride === null;
  return (
    <SettingsCard>
      <div data-buddy-model={bot.id}>
        <BotModelChainEditor
          layout="settings"
          settingsRows={{
            primaryLabel: bot.name,
            primaryHint: t(following ? 'bots.guided.modelFollowsDefault' : 'bots.guided.modelForThisBot'),
          }}
          hiddenVendors={hiddenVendors}
          value={displayedModelChain(capabilities, defaultChain)}
          onChange={(modelChain) => {
            const next = capabilitiesWithModelChain(capabilities, modelChain);
            if (next) save(next);
          }}
          {...(following ? {} : { onRestoreDefault: () => save(capabilitiesFollowingDefault(capabilities, defaultChain)) })}
          onNavigateToProviders={onNavigateToProviders}
        />
      </div>
    </SettingsCard>
  );
}
