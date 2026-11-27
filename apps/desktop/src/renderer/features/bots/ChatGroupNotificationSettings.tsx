import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Select } from '@/components/ui/select';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import type { ChatGroupNotificationMode } from '../../../shared/botGroupChat';
import { refreshBotGroups } from './botGroupStore';
import { SettingsRow } from '@/components/ui/settings-rows';

const key = (name: string) => `bots.groupChat.server.settings.notifications.${name}`;
const modes = ['all', 'mentions', 'none'] as const;

/** Personal preference, independent of group management or companion access. */
export function ChatGroupNotificationSettings({ groupId, mode, inherited = false, disabled }: {
  groupId: string; mode: ChatGroupNotificationMode; inherited?: boolean; disabled: boolean;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const saving = useRef(false);
  const mounted = useRef(false);
  // The choice shows at once; a refreshed server value, or a failure, ends it.
  const [chosen, setChosen] = useState<ChatGroupNotificationMode | null>(null);
  const shown = chosen ?? mode;
  const shownInherited = chosen === null && inherited;
  const confirmed = useRef({ mode, inherited }); confirmed.current = { mode, inherited };
  const isConfirmed = (value: string) => !confirmed.current.inherited && confirmed.current.mode === value;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setError(false); setChosen(null); }, [mode, inherited]);
  async function change(value: string) {
    if (saving.current || disabled || (!shownInherited && value === shown) || !modes.includes(value as ChatGroupNotificationMode)) return;
    saving.current = true; setBusy(true); setError(false); setChosen(value as ChatGroupNotificationMode);
    const owner = getDataOwnerGeneration();
    const current = () => mounted.current && isDataOwnerGenerationCurrent(owner);
    try {
      const result = await window.electronAPI.maker.chatServer.manage({ groupId, action: { type: 'notifications', mode: value as ChatGroupNotificationMode } });
      if (current() && !result.ok) { setChosen(null); if (!isConfirmed(value)) setError(true); }
    } catch { if (current()) { setChosen(null); if (!isConfirmed(value)) setError(true); } }
    finally {
      saving.current = false;
      if (current()) { setBusy(false); refreshBotGroups(); }
    }
  }
  return <>
    <SettingsRow wrap title={t(key('title'))} hint={t(key(`${shown}Hint`))} trailing={
      <Select label={t(key('title'))} value={shownInherited ? '' : shown} placeholder={shownInherited ? t(key(shown)) : undefined} disabled={disabled || busy} size="compact"
        triggerAdornment={busy ? <span role="status">{t(key('saving'))}</span> : undefined}
        options={modes.map(value => ({ value, label: t(key(value)) }))} onValueChange={value => void change(value)} />} />
    {error && <p role="alert" className="px-4 pb-3 text-12 leading-5 text-[var(--error-fg)]">{t(key('saveFailed'))}</p>}
  </>;
}
