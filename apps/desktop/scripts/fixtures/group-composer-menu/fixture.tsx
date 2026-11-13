import { forbid, mountPage, subscription } from '../../ui-page/harness';
import { BotGroupComposer } from '../../../src/renderer/features/bots/BotGroupComposer';
import { DEFAULT_APPEARANCE_SETTINGS } from '../../../src/shared/appearanceSettings';
import { getDefaultVoiceInputSettings } from '../../../src/shared/voiceInputData';

void mountPage({
  host: ({ data }) => ({
    voiceInput: {
      getDataSnapshot: () => ({ settings: { ...getDefaultVoiceInputSettings('win32'), fastActivationEnabled: false }, history: [] }),
      onDataChanged: subscription('voiceDataChanged'),
      onEvent: subscription('voiceEvent'),
      onGlobalShortcutTrigger: subscription('voiceShortcut'),
      setGlobalShortcut: async () => ({ ok: true }),
      prewarm: async () => ({ ok: true }),
      start: forbid('voiceInput.start'),
    },
    appearanceSettings: {
      getSync: () => ({ ...DEFAULT_APPEARANCE_SETTINGS, uiFamily: data.uiFamily ?? '' }),
      onChanged: subscription('appearance'),
    },
    maker: { onStateChanged: subscription('maker-state') },
    localDb: { botGroups: { onChanged: subscription('groups') } },
  }),
  render: ({ data }) => (
    <main className="flex h-screen flex-col justify-end bg-[var(--surface-base)] p-6 text-[var(--text-primary)]">
      <BotGroupComposer
        groupId="menu-fixture"
        draftKey="menu-fixture"
        members={[]}
        running={false}
        divisionSteps={Boolean(data.divisionSteps)}
      />
    </main>
  ),
});
