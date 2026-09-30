import { publicToolPhase, publicToolResultPhase, type WorkingPhase } from '@cindy/maker-shared';
import { parseMessageToolUse, messageContentToPreview } from '@cindy/maker-shared/message-normalize';
import { isSubagentParentToolUseId } from '@cindy/maker-shared/message-render';
import type { RemoteMessage } from './types';

/** Only the current foreground turn can supply a caption. Never expose tool inputs. */
export function companionWorkingPhase(messages: readonly RemoteMessage[]): { phase: WorkingPhase | null; turnId: string } {
  let phase: WorkingPhase | null = 'thinking';
  let turnId = '';
  const tools = new Map<string, WorkingPhase>();
  for (const message of messages) {
    if (message.role === 'user') { turnId = message.id; phase = 'thinking'; tools.clear(); continue; }
    if (!turnId || message.agentMeta?.turnScope === 'background'
      || typeof message.agentMeta?.parentToolUseId === 'string' && isSubagentParentToolUseId(message.agentMeta.parentToolUseId)) continue;
    if (message.role === 'tool_use') {
      const tool = parseMessageToolUse(message);
      phase = publicToolPhase(tool.toolName, tool.input);
      if (tool.toolUseId) tools.set(tool.toolUseId, phase);
    } else if (message.role === 'tool_result') {
      const id = message.toolUseId ?? (message.content && typeof message.content === 'object' ? (message.content as Record<string, unknown>).toolUseId : null);
      if (typeof id === 'string' && tools.has(id)) { phase = publicToolResultPhase(tools.get(id)!); tools.delete(id); }
    } else if (message.role === 'assistant' && messageContentToPreview(message.content).trim()) phase = 'replying';
    else if (message.role === 'ask_user' || message.role === 'plan_review' || message.role === 'error') phase = null;
  }
  return { phase, turnId };
}
