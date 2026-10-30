import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormField } from '@/components/ui/form-field';
import { Select } from '@/components/ui/select';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import type { ChatGroupNotificationMode } from '../../../shared/botGroupChat';
import { refreshBotGroups } from './botGroupStore';

const key = (name: string) => `bots.groupChat.server.settings.notifications.${name}`;
const modes = ['all', 'mentions', 'none'] as const;

/** Personal preference, independent of group management or companion access. */
export function ChatGroupNotificationSettings({ groupId, mode, disabled }: {
  groupId: string; mode: ChatGroupNotificationMode; disabled: boolean;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const saving = useRef(false);
  const mounted = useRef(false);
  const confirmed = useRef(mode); confirmed.current = mode;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setError(false); }, [mode]);
  async function change(value: string) {
    if (saving.current || disabled || value === mode || !modes.includes(value as ChatGroupNotificationMode)) return;
    saving.current = true; setBusy(true); setError(false);
    const owner = getDataOwnerGeneration();
    const current = () => mounted.current && isDataOwnerGenerationCurrent(owner);
    try {
      const result = await window.electronAPI.maker.chatServer.manage({ groupId, action: { type: 'notifications', mode: value as ChatGroupNotificationMode } });
      if (current() && !result.ok && confirmed.current !== value) setError(true);
    } catch { if (current() && confirmed.current !== value) setError(true); }
    finally {
      saving.current = false;
      if (current()) { setBusy(false); refreshBotGroups(); }
    }
  }
  return <div className="space-y-2">
    <FormField label={t(key('title'))} hint={t(key(`${mode}Hint`))}>{props =>
      <Select {...props} label={t(key('title'))} value={mode} disabled={disabled || busy}
        triggerAdornment={busy ? <span role="status">{t(key('saving'))}</span> : undefined}
        options={modes.map(value => ({ value, label: t(key(value)) }))} onValueChange={value => void change(value)} />}
    </FormField>
    {error && <p role="alert" className="text-12 leading-5 text-[var(--error-fg)]">{t(key('saveFailed'))}</p>}
  </div>;
}
