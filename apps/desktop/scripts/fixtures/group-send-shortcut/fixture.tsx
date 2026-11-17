import { useEffect, useState } from 'react';
import { forbid, mountPage, subscription } from '../../ui-page/harness';
import { BotGroupComposer } from '../../../src/renderer/features/bots/BotGroupComposer';
import { DEFAULT_APPEARANCE_SETTINGS } from '../../../src/shared/appearanceSettings';
import { getDefaultVoiceInputSettings } from '../../../src/shared/voiceInputData';
import { COMPOSER_SEND_SHORTCUT_STORAGE_KEY } from '../../../src/renderer/hooks/useComposerSendShortcutPreference';

// The isolated HTTP origin lacks secure-context UUIDs; only fixture send IDs use these.
if (!crypto.randomUUID) {
  let sequence = 0;
  crypto.randomUUID = () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`;
}

function Surface({ mode }: { mode: 'group' | 'thread' }) {
  const [sent, setSent] = useState<string[]>([]);
  useEffect(() => {
    const receive = (event: Event) => setSent(previous => [...previous, (event as CustomEvent<string>).detail]);
    window.addEventListener('fixture-group-send', receive);
    return () => window.removeEventListener('fixture-group-send', receive);
  }, []);
  return <main className="flex h-screen flex-col justify-end gap-4 bg-[var(--surface-base)] p-6 text-[var(--text-primary)]">
    <output aria-label="Sent messages">{JSON.stringify(sent)}</output>
    <BotGroupComposer groupId="shortcut-fixture" draftKey={`shortcut-${mode}`} mode={mode}
      members={[{ botId: 'fixture-bot', name: 'Teammate', avatar: '', avatarColor: 'red', status: 'active' }]} running={false}
      sendReply={async () => ({ ok: true, messageId: 'reply' })}
      onSendStart={message => setSent(previous => [...previous, message.text])} />
  </main>;
}

void mountPage({
  host: () => {
    localStorage.setItem(COMPOSER_SEND_SHORTCUT_STORAGE_KEY, 'modifier-enter');
    return {
      voiceInput: {
        getDataSnapshot: () => ({ settings: { ...getDefaultVoiceInputSettings('win32'), fastActivationEnabled: false }, history: [] }),
        onDataChanged: subscription('voiceDataChanged'), onEvent: subscription('voiceEvent'),
        onGlobalShortcutTrigger: subscription('voiceShortcut'), setGlobalShortcut: async () => ({ ok: true }),
        prewarm: async () => ({ ok: true }), start: forbid('voiceInput.start'),
      },
      appearanceSettings: { getSync: () => DEFAULT_APPEARANCE_SETTINGS, onChanged: subscription('appearance') },
      maker: {
        onStateChanged: subscription('maker-state'), listBotGroups: async () => ({ ok: true, groups: [] }),
        sendBotGroupMessage: async (input: { text: string }) => {
          window.dispatchEvent(new CustomEvent('fixture-group-send', { detail: input.text }));
          return { ok: true, messageId: 'group-message' };
        },
      },
      localDb: { botGroups: { onChanged: subscription('groups') } },
    };
  },
  render: ({ data }) => <Surface mode={data.mode === 'thread' ? 'thread' : 'group'} />,
});
