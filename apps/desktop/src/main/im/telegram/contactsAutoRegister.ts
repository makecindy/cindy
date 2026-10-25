import { createTelegramSpeakerRegistration } from '@cindy/im-runtime/channels/telegram/contacts';
import { createLogger } from '../../logger.js';
import { emitLocalContactsChanged } from '../../maker-host/contacts-change-events.js';
import { getDesktopContactsManager } from '../../maker-host/maker-contacts-host.js';
import { readContactsSettingsState } from '../../maker-host/contacts-settings-store.js';
export type { TelegramSpeakerToRegister } from '@cindy/im-runtime/channels/telegram/contacts';
export const { autoRegisterTelegramSpeaker, resetTelegramSpeakerRegistrationCache } = createTelegramSpeakerRegistration({
  enabled: () => readContactsSettingsState().value.enabled,
  getStore: () => getDesktopContactsManager().getStore(),
  changed: emitLocalContactsChanged,
  log: createLogger('telegram-contacts-auto'),
});
