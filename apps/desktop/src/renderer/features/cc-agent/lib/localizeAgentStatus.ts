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
export function localizePlainAgentStatus(
  status: string,
  messages: readonly Message[],
  startedAt: number | null,
  t: TFunction,
): string {
  const normalized = normalizeStaticStatus(status);
  if (normalized === 'waiting on approval' || normalized === 'waiting on input') {
    return localizeAgentStatus(status, t);
  }
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.systemCardType || (
      message.parentToolUseId && isSubagentParentToolUseId(message.parentToolUseId)
    )) continue;
    if (message.role === 'user' && message.delivery !== 'steer' && !message.isSyntheticTrigger) break;
    if (startedAt !== null && message.createdAt && Date.parse(message.createdAt) < startedAt) continue;
    if (message.role === 'thinking' && message.isStreaming) {
      return localizeAgentStatus('Thinking', t);
    }
    if (message.role === 'assistant' && message.isStreaming && message.content.trim()) {
      return t('ccAgent.agentStatus.replying');
    }
    // A tool boundary seals prior text; don't rediscover that text behind it.
    if (message.role === 'tool_use' || message.role === 'tool_result') {
      return t('ccAgent.agentStatus.processing');
    }
    if (message.role === 'assistant') break;
  }
  if (normalized === 'thinking') return localizeAgentStatus(status, t);
  // Generating can also be a translator's between-items fallback. Only a live
  // text block above justifies claiming a reply is currently being written.
  return t('ccAgent.agentStatus.processing');
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
