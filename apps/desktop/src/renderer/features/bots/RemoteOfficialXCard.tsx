import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { CompanionXAssignment } from '@/components/settings/CompanionXAssignment';
import { XUsageGuide } from '@/components/settings/XUsageGuide';
import { Spinner } from '@/components/ui/spinner';
import type { BotSettingsTarget } from './botSettingsTarget';
import type { BotProfile } from './botStore';

type XApi = NonNullable<BotSettingsTarget['channels']['x']>;
type XState = Awaited<ReturnType<XApi['get']>>;

/**
 * The official X account of the teammate's computer, as a teammate on that computer sees it: how X
 * questions work and that replies are public (the same guide as this computer's X card), who the account
 * is assigned to, and assigning it to or releasing it from this teammate. Signing in to X opens a browser
 * on that computer, so connecting stays there.
 */
export function RemoteOfficialXCard({ bot, api, deviceName }: { bot: Pick<BotProfile, 'id' | 'name'>; api: XApi; deviceName: string }) {
  const { t } = useTranslation();
  const [state, setState] = useState<XState | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(() => {
    setFailed(false);
    void api.get().then(setState, () => setFailed(true));
  }, [api]);
  useEffect(load, [load]);

  if (!state && !failed) {
    return (
      <div className="flex justify-center py-4 text-[var(--text-tertiary)]">
        <Spinner size={16} />
      </div>
    );
  }
  // Listed whenever the teammate's own settings list it (also set up there but not usable yet); an
  // older computer does not say, and then it is listed only once usable.
  if (!state || !(state.available || state.visible)) return null;
  const ready = state.enabled && state.connected;
  return (
    <section
      className="flex flex-col gap-2 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] px-4 py-3"
      aria-label={t('settings.tina.prefs.providerX')}
    >
      <p className="text-14 text-[var(--text-primary)]">{t('settings.tina.prefs.providerX')}</p>
      <XUsageGuide companion={!!state.companionBotId} deviceName={deviceName || undefined} />
      <div className="flex flex-col gap-2 border-t border-[var(--border-default)] pt-3">
        <CompanionXAssignment
          companion={bot}
          companionBotId={state.companionBotId}
          assign={async (assign, expectedBotId) => {
            const next = await api.setCompanion(assign, expectedBotId);
            setState((current) => (current ? { ...current, companionBotId: next.companionBotId } : current));
          }}
          onFailed={load}
          // Connecting the account signs in through a browser on the computer that runs it.
          unavailable={ready ? undefined : (
            <p className="text-12 leading-relaxed text-[var(--text-secondary)]">
              {t('bots.remoteSettings.finishOnHost', { device: deviceName })}
            </p>
          )}
        />
      </div>
    </section>
  );
}
