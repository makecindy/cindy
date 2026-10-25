import fs from 'node:fs';
import type { TelegramIM } from '@cindy/im';
import { buildTelegramAdapter as buildSharedAdapter, type TelegramAdapterOptions } from '@cindy/im-runtime/channels/telegram/adapter';
import type { ImOrchestratorConfig } from '../shared/types';
import { ownerScopedImUserDataPath } from '../ownerScopedStorage';
import { buildTelegramGroupContextPrefix } from './groupWindow';
import { readTelegramPersona } from './behaviorStore';
import { autoRegisterTelegramSpeaker } from './contactsAutoRegister';
export { TELEGRAM_TOOLS_HINT, type TelegramAdapterOptions } from '@cindy/im-runtime/channels/telegram/adapter';
export function buildTelegramAdapter(im: TelegramIM, config: ImOrchestratorConfig, options: TelegramAdapterOptions = {}) {
  return buildSharedAdapter(im, config, { buildTelegramGroupContextPrefix, readTelegramPersona, autoRegisterTelegramSpeaker,
    ensureWorkingDir: botId => {
      const dir = ownerScopedImUserDataPath('im-working-dir', `telegram-${botId}`);
      fs.mkdirSync(dir, { recursive: true }); return dir;
    },
  }, options);
}
