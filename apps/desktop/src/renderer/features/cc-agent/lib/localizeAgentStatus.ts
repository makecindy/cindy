import { isCompactingWorkingStatus, publicToolPhase, publicToolResultPhase, WORKING_PHASE_KEYS, type PlainAgentPhase } from '../../../../shared/workingStatus';
import type { TFunction } from 'i18next';
import type { ChatMessage as Message } from '@/lib/makerChatStore';
import { isSubagentParentToolUseId } from '@cindy/maker-shared/message-render';

const STATUS_KEYS = new Map<string, string>([
  ['thinking', 'ccAgent.agentStatus.thinking'],
  ['generating', 'ccAgent.agentStatus.generating'],
  ['editing files', 'ccAgent.agentStatus.editingFiles'],
  ['searching web', 'ccAgent.agentStatus.searchingWeb'],
  ['generating image', 'ccAgent.agentStatus.generatingImage'],
  ['compacting', 'ccAgent.agentStatus.compacting'],
  ['spawning agent', 'ccAgent.agentStatus.spawningAgent'],
  ['done', 'ccAgent.agentStatus.done'],
  ['waiting on approval', 'ccAgent.sidebar.card.awaitingPermission'],
  ['waiting on input', 'ccAgent.sidebar.card.awaitingQuestion'],
  ['just wait', 'ccAgent.agentStatus.waiting'],
  ['working', 'ccAgent.agentStatus.working'],
  ['running', 'ccAgent.agentStatus.running'],
]);

const TURN_START_NAME_PATTERNS = [
  /^Nice day, (.+)!$/i,
  /^Hey (.+), here we go$/i,
  /^(.+), sit tight$/i,
  /^Crafting for (.+?)(?:\.{3}|…)$/i,
  /^(.+), on it$/i,
  /^Brewing magic for (.+?)(?:\.{3}|…)$/i,
  /^Take a breath, (.+)$/i,
  /^Let's go, (.+)!$/i,
  /^(.+), leave it to me$/i,
  /^Working on it, (.+)$/i,
];

function normalizeStaticStatus(status: string): string {
  return status
    .trim()
    .replace(/(?:\.{3}|…)$/, '')
    .trim()
    .toLowerCase();
}

/** Plain composer copy uses the same runtime status as the task status bar.
 * Pi reports Working for both text and reasoning, so prefer its live blocks.
 * Completed text is never evidence that the product turn has finished.
 */
export function resolvePlainAgentPhase(
  status: string,
  messages: readonly Message[],
  startedAt: number | null,
): PlainAgentPhase {
  const normalized = normalizeStaticStatus(status);
  if (normalized === 'waiting on approval' || normalized === 'waiting on input') {
    return normalized === 'waiting on approval' ? 'waiting-approval' : 'waiting-input';
  }
  // Runtime compaction takes priority over the preceding live text/tool block.
  if (isCompactingWorkingStatus(status)) return 'compacting';
  let thinking = false;
  let resultToolId: string | undefined;
  let sawResult = false;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.systemCardType || (
      message.parentToolUseId && isSubagentParentToolUseId(message.parentToolUseId)
    )) continue;
    if (message.role === 'user' && message.delivery !== 'steer' && !message.isSyntheticTrigger) break;
    if (startedAt !== null && message.createdAt && Date.parse(message.createdAt) < startedAt) continue;
    if (message.role === 'thinking' && message.isStreaming) {
      thinking = true;
      continue;
    }
    if (!thinking && message.role === 'assistant' && message.isStreaming && message.content.trim()) {
      return 'replying';
    }
    // A tool boundary seals prior text; don't rediscover that text behind it.
    if (message.role === 'tool_result') {
      if (!sawResult) resultToolId = message.toolUseId;
      sawResult = true;
      continue;
    }
    if (message.role === 'tool_use') {
      if (sawResult && resultToolId && message.toolUseId !== resultToolId) continue;
      const action = publicToolPhase(message.toolName, message.toolInput);
      const feedback = publicToolResultPhase(action);
      return sawResult && feedback !== 'processing' ? feedback : thinking ? 'thinking' : sawResult ? 'processing' : action;
    }
    if (message.role === 'assistant') break;
  }
  if (thinking || normalized === 'thinking') return 'thinking';
  // Generating can also be a translator's between-items fallback. Only a live
  // text block above justifies claiming a reply is currently being written.
  return 'processing';
}

export function localizePlainAgentStatus(
  status: string, messages: readonly Message[], startedAt: number | null, t: TFunction,
): string {
  const phase = resolvePlainAgentPhase(status, messages, startedAt);
  if (phase === 'waiting-input' || phase === 'waiting-approval') return localizeAgentStatus(status, t);
  return t(WORKING_PHASE_KEYS[phase]);
}

/**
 * Localizes Cindy-owned Agent status chrome while preserving vendor/tool names
 * and arbitrary status text verbatim. Raw terminal stdout/stderr never passes
 * through this helper.
 */
export function localizeAgentStatus(status: string, t: TFunction): string {
  const staticKey = STATUS_KEYS.get(normalizeStaticStatus(status));
  if (staticKey) return t(staticKey);

  const trimmedStatus = status.trim();
  const issueTip = trimmedStatus.match(/^(.+),试试 \/issue 给我们提反馈或建议$/);
  if (issueTip) {
    return t('ccAgent.agentStatus.issueTip', { name: issueTip[1] });
  }

  for (const pattern of TURN_START_NAME_PATTERNS) {
    const match = trimmedStatus.match(pattern);
    if (match) {
      return t('ccAgent.agentStatus.turnStart', { name: match[1], status: trimmedStatus });
    }
  }

  const runningTool = trimmedStatus.match(/^(.+?) running(?:\.{3}|…)$/i);
  if (runningTool) {
    return t('ccAgent.agentStatus.runningTool', { tool: runningTool[1] });
  }

  return status;
}
