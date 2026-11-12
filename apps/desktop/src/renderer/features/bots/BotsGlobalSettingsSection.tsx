import { additionalSettings } from '@/components/settings/AdditionalSettings.settings-search';
import { useSettingDefinition } from '@/components/settings/useSettingDefinition';
/** Shared default model chain; individual teammates may override it. */
import { useEffect, useRef, useState } from 'react';
import { useBotTranslation } from './botPronounContext';

import { cn } from '@/lib/utils';
import {
  SETTINGS_HINT,
  SettingsCard,
  SettingsRow,
  SettingsSection,
} from '@/components/ui/settings-rows';
import { Switch } from '@/components/ui/switch';
import { useBotReplyTargetPreference } from './useBotReplyTargetPreference';
import { useProviders } from '@/hooks/useProviders';
import { useAvailableAgents } from '@/hooks/useAvailableAgents';
import {
  getEffectiveBotModelChain,
  isBotGlobalModelChainCustomized,
  resetBotGlobalModelChain,
  setBotGlobalModelChain,
  subscribeBotGlobalModel,
} from './botStore';
import { BotModelChainEditor } from './BotModelChainEditor';

export function BotsGlobalSettingsSection() {
  const { t } = useBotTranslation();
  const modelSetting = useSettingDefinition(additionalSettings.botModel, t);
  const replySetting = useSettingDefinition(additionalSettings.botReplyTarget, t);
  // Re-render derived defaults when the shared picker inputs change, including
  // when the empty-chain editor has no ModelSelector mounted yet.
  useProviders();
  useAvailableAgents();
  const [, bumpModelSettings] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => subscribeBotGlobalModel(() => bumpModelSettings((value) => value + 1)), []);
  const modelChain = getEffectiveBotModelChain();
  const customized = isBotGlobalModelChainCustomized();
  const replyTarget = useBotReplyTargetPreference();
  const pendingRef = useRef(false);
  const [pending, setPending] = useState(false);

  const changeModelChain = (operation: () => Promise<void>, restoring = false) => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setNotice(null);
    void operation().catch((error: unknown) => {
      setNotice(restoring
        ? t('bots.globalSettings.restoreFailed')
        : error instanceof Error ? error.message : String(error));
    }).finally(() => {
      pendingRef.current = false;
      setPending(false);
    });
  };

  return (
    <SettingsSection title={t('bots.globalSettings.title')}>
      <SettingsCard>
        <fieldset {...modelSetting.anchorProps} disabled={pending} aria-busy={pending} className="min-w-0">
          <BotModelChainEditor {...modelSetting.controlProps}
            layout="settings"
            settingsRows={{
              primaryLabel: modelSetting.title,
              primaryHint: modelSetting.description,
            }}
            disabled={pending}
            value={modelChain}
            onChange={(next) => changeModelChain(() => setBotGlobalModelChain(next))}
            onRestoreDefault={customized !== false
              ? () => changeModelChain(resetBotGlobalModelChain, true)
              : undefined}
          />
        </fieldset>
        {notice ? (
          <p className={cn(SETTINGS_HINT, 'px-4 pb-4')} role="status">
            {notice}
          </p>
        ) : null}
      </SettingsCard>

      <SettingsCard>
        <SettingsRow
          {...replySetting.anchorProps}
          title={replySetting.title}
          hint={replySetting.description}
          trailing={
            <Switch {...replySetting.controlProps}
              aria-label={replySetting.title}
              className="shrink-0"
              checked={replyTarget.enabled}
              onCheckedChange={(value) => replyTarget.setEnabled(value === true)}
            />
          }
        />
      </SettingsCard>
    </SettingsSection>
  );
}
