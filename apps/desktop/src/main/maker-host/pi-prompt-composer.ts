/** Pi prompt composition kept separate from the heavyweight runtime host. */

import piSystemPrompt from './pi-system-prompt.md?raw';
import { composeHostPrompt } from './host-prompt-composer.js';

export function composePiSystemPrompt(hostPrompt: string, agentPrompt: string): string {
  return [hostPrompt, agentPrompt]
    .map((section) => section.trim())
    .filter(Boolean)
    .join('\n\n');
}

export function composeDesktopPiSystemPrompt(): string {
  return composePiSystemPrompt(
    composeHostPrompt('', { includeSkillSourcePrecedence: false }),
    piSystemPrompt,
  );
}
