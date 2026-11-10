/** Shared host prompt sections and their persisted attribution policy. */

import hostSystemPrompt from './host-system-prompt.md?raw';
import commitAttributionPrompt from './commit-attribution-prompt.md?raw';
import hostRuntimePrompt from './host-runtime-prompt.md?raw';
import businessOwnershipPrompt from './business-ownership-prompt.md?raw';
import skillSourcePrecedencePrompt from './skill-source-precedence-prompt.md?raw';
import { readCommitAttributionSettings } from './commit-attribution-settings-store.js';

// Keep the prefix order stable: identity → optional attribution → runtime →
// ownership → Skill precedence → agent-specific guidance. A new agent session
// reads the preference once; running sessions never mutate their prompt prefix.
export function composeHostPrompt(
  agentSpecific: string,
  options: { includeSkillSourcePrecedence?: boolean } = {},
): string {
  return [
    hostSystemPrompt,
    readCommitAttributionSettings().enabled ? commitAttributionPrompt : '',
    hostRuntimePrompt,
    businessOwnershipPrompt,
    options.includeSkillSourcePrecedence === false ? '' : skillSourcePrecedencePrompt,
    agentSpecific,
  ]
    .map((section) => section.trim())
    .filter((section) => section.length > 0)
    .join('\n\n');
}
