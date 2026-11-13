import { ipcMain } from 'electron';

import { COMPOSER_ENHANCE_PROMPT_CHANNEL } from '../shared/composerPromptEnhance.js';
import { assertTrustedAppRendererEvent } from './security/trustedAppRenderer.js';
import { throwIpcError } from './utils/ipcValidate.js';
import { enhanceComposerPrompt } from './composer-prompt-enhance.js';
import { getMaker } from './maker-host/index.js';
import { requestUtilityText } from './utility-model/oneShotCandidates.js';

let registered = false;

/**
 * Registers the composer's "enhance prompt" action.
 *
 * The rewrite runs on the auxiliary-model chain the user configured under
 * Settings, so it never spends the quota of the model the conversation is
 * about to use.
 */
export function registerComposerPromptEnhanceIpc(): void {
  if (registered) return;
  registered = true;

  ipcMain.handle(COMPOSER_ENHANCE_PROMPT_CHANNEL, async (event, rawText: unknown) => {
    assertTrustedAppRendererEvent(event);
    if (typeof rawText !== 'string') {
      throwIpcError('INVALID_PARAMS', 'Prompt text must be a string');
    }
    return enhanceComposerPrompt(
      (prompt, options) => requestUtilityText(getMaker(), prompt, options),
      rawText,
    );
  });
}
