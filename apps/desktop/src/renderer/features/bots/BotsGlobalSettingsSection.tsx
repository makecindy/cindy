/** Shared default model chain; individual teammates may override it. */
import { useEffect, useRef, useState } from 'react';
import { useBotTranslation } from './botPronounContext';

import { cn } from '@/lib/utils';
import {
  getEffectiveBotModelChain,
  isBotGlobalModelChainCustomized,
  resetBotGlobalModelChain,
  setBotGlobalModelChain,
  subscribeBotGlobalModel,
} from './botStore';
import { BotModelChainEditor } from './BotModelChainEditor';

const CARD_CLASS = cn(
  'rounded-xl p-5',
  'bg-[var(--settings-theme-card-bg)]',
  'border border-[var(--settings-theme-card-border)]',
);

const ROW_LABEL_CLASS = 'text-13 font-medium text-[var(--settings-section-sublabel)]';
const ROW_HINT_CLASS =
  'text-12 leading-[1.4] text-[var(--settings-section-sublabel)] opacity-70';

export function BotsGlobalSettingsSection() {
  const { t } = useBotTranslation();
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
      <h2 className="text-16 font-medium leading-[1.2] text-[var(--settings-section-title)]">
        {t('bots.globalSettings.title')}
      </h2>
      <p className="-mt-2 text-12 leading-[1.5] text-[var(--settings-section-sublabel)] opacity-70">
        {t('bots.globalSettings.description')}
      </p>

      <div className={cn(CARD_CLASS, 'flex flex-col gap-4')}>
        <div>
          <p className={ROW_LABEL_CLASS}>{t('bots.modelLabel')}</p>
          <p className={cn('mt-1', ROW_HINT_CLASS)}>
            {t('bots.globalSettings.description')}
          </p>
        </div>
        <fieldset disabled={pending} aria-busy={pending} className="min-w-0">
          <BotModelChainEditor
            value={modelChain}
            onChange={(next) => changeModelChain(() => setBotGlobalModelChain(next))}
            onRestoreDefault={customized !== false
              ? () => changeModelChain(resetBotGlobalModelChain, true)
              : undefined}
          />
        </fieldset>
        <p className={ROW_HINT_CLASS}>{t('bots.globalSettings.restoreHint')}</p>
        {notice ? (
          <p className={ROW_HINT_CLASS} role="status">
            {notice}
          </p>
        ) : null}
      </div>

      <p className={ROW_HINT_CLASS}>{t('bots.globalSettings.rosterNote')}</p>
    </div>
  );
}
