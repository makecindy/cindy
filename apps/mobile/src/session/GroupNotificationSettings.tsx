import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ChatGroupNotificationMode } from '@cindy/maker-shared/botGroupChat';
import { BotGroupMenu } from './BotGroupMenu';
import { ActionInfoRow, SettingsGroup } from './SettingsGroupRows';

const key = (name: string) => `groupChat.settings.notifications.${name}`;
const modes = ['all', 'mentions', 'none'] as const;

/** Uses the server-confirmed value; ordinary members can edit their own alerts. */
export function GroupNotificationSettings({ mode, disabled, save, title }: {
  mode: ChatGroupNotificationMode; disabled: boolean; save(mode: ChatGroupNotificationMode): Promise<unknown>; title?: string;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const writing = useRef(false);
  const mounted = useRef(false);
  const confirmed = useRef(mode); confirmed.current = mode;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setError(false); }, [mode]);
  const label = t(key('title'));
  const value = t(key(busy ? 'saving' : mode));
  async function change(value: string) {
    if (disabled || writing.current || value === mode || !modes.includes(value as ChatGroupNotificationMode)) return;
    writing.current = true; setBusy(true); setError(false);
    try { await save(value as ChatGroupNotificationMode); }
    catch { if (mounted.current && confirmed.current !== value) setError(true); }
    finally { writing.current = false; if (mounted.current) setBusy(false); }
  }
  return <SettingsGroup title={title} footer={t(key(`${mode}Hint`))}
    messages={[error && { text: t(key('saveFailed')), testID: 'botGroup.settings.notifications.error' }]}>
    <BotGroupMenu title={label} accessibilityLabel={`${label}: ${value}`} disabled={disabled || busy}
      testID="botGroup.settings.notifications" sections={[{ id: 'notifications', options: modes.map(value => ({ id: value, title: t(key(value)), selected: value === mode })) }]}
      onSelect={value => void change(value)}>
      {open => <ActionInfoRow label={label} value={value} accessibilityLabel={`${label}: ${value}`}
        chevron={false} disabled={disabled || busy} onPress={() => open?.()} testID="botGroup.settings.notifications.value" />}
    </BotGroupMenu>
  </SettingsGroup>;
}
