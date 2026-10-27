import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/lib/toast';
import type { BotSettingsTarget } from './botSettingsTarget';
import type { BotProfile } from './botStore';

type XApi = NonNullable<BotSettingsTarget['channels']['x']>;
type XState = Awaited<ReturnType<XApi['get']>>;

/**
 * The official X account of the teammate's computer, as a teammate on that computer sees it: who it is
 * assigned to, and assigning it to or releasing it from this teammate. Signing in to X opens a browser on
 * that computer, so connecting stays there.
 */
export function RemoteOfficialXCard({ bot, api, deviceName }: { bot: Pick<BotProfile, 'id' | 'name'>; api: XApi; deviceName: string }) {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();
  const [state, setState] = useState<XState | null>(null);
  const [failed, setFailed] = useState(false);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);

  const load = useCallback(() => {
    setFailed(false);
    void api.get().then(setState, () => setFailed(true));
  }, [api]);
  useEffect(load, [load]);

  const bound = state?.companionBotId === bot.id;
  const change = async () => {
    if (busy.current || !state) return;
    busy.current = true;
    setPending(true);
    try {
      const ok = await confirm({
        title: t(`bots.channels.officialX.${bound ? 'removeTitle' : 'bindTitle'}`, { name: bot.name }),
        description: t(`bots.channels.officialX.${bound ? 'removeBody' : 'bindBody'}`, { name: bot.name }),
        confirmText: t(`bots.channels.officialX.${bound ? 'remove' : 'bind'}`),
      });
      if (!ok) return;
      const next = await api.setCompanion(!bound, state.companionBotId);
      setState({ ...state, companionBotId: next.companionBotId });
    } catch {
      toast.error(t('settings.remoteControl.hook.toast.actionFailed'));
      load();
    } finally {
      busy.current = false;
      setPending(false);
    }
  };

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
      <p className="text-12 leading-relaxed text-[var(--text-secondary)]">
        {t(
          bound
            ? 'bots.channels.officialX.bound'
            : state.companionBotId
              ? 'bots.channels.officialX.boundElsewhere'
              : 'bots.channels.officialX.unbound',
          { name: bot.name },
        )}
      </p>
      {ready || bound ? (
        <div>
          <Button variant="secondary" size="sm" type="button" loading={pending} disabled={pending} onClick={() => void change()}>
            {t(bound ? 'bots.channels.officialX.remove' : 'bots.channels.officialX.bind')}
          </Button>
        </div>
      ) : (
        // Connecting the account signs in through a browser on the computer that runs it.
        <p className="text-12 leading-relaxed text-[var(--text-secondary)]">
          {t('bots.remoteSettings.finishOnHost', { device: deviceName })}
        </p>
      )}
    </section>
  );
}
