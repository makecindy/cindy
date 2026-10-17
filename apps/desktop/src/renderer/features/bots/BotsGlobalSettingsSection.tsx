/** Shared default model chain; individual teammates may override it. */
import { useEffect, useRef, useState } from 'react';
import { useBotTranslation } from './botPronounContext';

import { cn } from '@/lib/utils';
import {
  SETTINGS_CARD_CLASS,
  SETTINGS_ROW_HINT_CLASS,
  SETTINGS_SECTION_TITLE_CLASS,
} from '@/components/settings/settingsRowClasses';
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
  // Re-render derived defaults when the shared picker inputs change, including
  // when the empty-chain editor has no ModelSelector mounted yet.
  useProviders();
  useAvailableAgents();
  const [, bumpModelSettings] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => subscribeBotGlobalModel(() => bumpModelSettings((value) => value + 1)), []);
  const modelChain = getEffectiveBotModelChain();
  const customized = isBotGlobalModelChainCustomized();
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
    <div className="flex flex-col gap-[14px]">
      <h2 className={SETTINGS_SECTION_TITLE_CLASS}>{t('bots.globalSettings.title')}</h2>

      <div className={SETTINGS_CARD_CLASS}>
        <fieldset disabled={pending} aria-busy={pending} className="min-w-0">
          <BotModelChainEditor
            layout="settings"
            settingsRows={{
              primaryLabel: t('bots.globalSettings.defaultModel'),
              primaryHint: t('bots.globalSettings.defaultModelHint'),
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
          <p className={cn(SETTINGS_ROW_HINT_CLASS, 'px-4 pb-4')} role="status">
            {notice}
          </p>
        ) : null}
      </div>
    </div>
  );
}
