import type { AgentEvent } from '@cindy/maker-core';

/**
 * Live SDK child events share the parent's session stream, but are not replies
 * to its IM audience. Filter before text, media and lifecycle handling, including
 * scheduled-turn forwarding. This is live agentMeta, not imported transcript
 * ancestry: Claude's translator puts parent_tool_use_id in parentUuid.
 */
export function isImSubagentEvent(event: AgentEvent): boolean {
  const parent = event.agentMeta?.parentUuid;
  return typeof parent === 'string' && parent.length > 0;
}
