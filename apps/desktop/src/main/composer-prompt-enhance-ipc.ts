import { ipcMain } from 'electron';

import { COMPOSER_ENHANCE_PROMPT_CHANNEL } from '../shared/composerPromptEnhance.js';
import { assertTrustedAppRendererEvent } from './security/trustedAppRenderer.js';
import { throwIpcError } from './utils/ipcValidate.js';
import { enhanceComposerPrompt } from './composer-prompt-enhance.js';

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
    // Dynamic import: utility-model reads the electron app path at module top
    // level, so a static import would pull that chain into every importer's
    // unit tests (same pattern as the oneshot text route).
    const [{ requestUtilityText }, { getMaker }] = await Promise.all([
      import('./utility-model/oneShotCandidates.js'),
      import('./maker-host/index.js'),
    ]);
    return enhanceComposerPrompt(
      (prompt, options) => requestUtilityText(getMaker(), prompt, options),
      rawText,
    );
  });
}
