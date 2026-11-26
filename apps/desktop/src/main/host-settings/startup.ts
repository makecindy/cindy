import type { CreateSessionOptions } from '@cindy/maker-core';
import { isManagedCloudInstance, windowUserPrompt } from './personalization.js';

export type PersonalizationCallerScope = 'owner' | 'scoped';

/** Capture the personal instructions before project and role context is assembled. */
export async function captureHostPersonalization(
  opts: Pick<CreateSessionOptions, 'userPrompt' | 'hostStartupPreferences' | 'makerMemoryEnabled' | 'displayReasoning'>,
  scope?: PersonalizationCallerScope,
): Promise<void> {
  let userPrompt = opts.userPrompt;
  if (scope === 'scoped') userPrompt = undefined;
  else if (scope === 'owner' || isManagedCloudInstance()) userPrompt = await windowUserPrompt();
  opts.userPrompt = userPrompt;
  opts.hostStartupPreferences = {
    userPrompt,
    makerMemoryEnabled: opts.makerMemoryEnabled,
    displayReasoning: opts.displayReasoning,
  };
}
