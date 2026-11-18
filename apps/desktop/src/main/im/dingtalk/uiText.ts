import { imText } from '../shared/imText';
import type { ImUiTextPack } from '../shared/types';
import { ui as telegramUi } from '../telegram/uiText';
import { relabeledUiPack, telegramChannelRelabel } from './relabeledUiPack';

const K = 'imBot.text.dingtalk';

/**
 * Shared IM control copy is channel-neutral apart from a small number of
 * route labels. Keep the DingTalk pack derived at the composition boundary so
 * fixes to permissions, model selection, and takeover guidance stay aligned.
 * The derivation is a lazy view: every leaf is read (in the owner's current
 * interface language) when a message is built, never frozen at import time.
 */
export const ui: ImUiTextPack = relabeledUiPack<ImUiTextPack>(
  telegramUi,
  telegramChannelRelabel(() => imText(`${K}.channelName`)),
  {
    error: {
      get permissionModeUnsupported() { return imText(`${K}.error.permissionModeUnsupported`); },
    },
    slash: {
      get help() { return imText(`${K}.slash.help`); },
      unknownCommand: (cmd: string) => imText(`${K}.slash.unknownCommand`, { cmd }),
      interactiveCommandUnsupported: (cmd: string) =>
        imText(`${K}.slash.interactiveCommandUnsupported`, { cmd }),
    },
  },
);
