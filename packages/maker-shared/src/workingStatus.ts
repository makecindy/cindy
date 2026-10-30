import { describeToolUse, parseToolName } from './toolUseDescriptor.js';

/** Public execution facts only. Never send targets, arguments or reasoning to a model. */
export const WORKING_PHASES = [
  'thinking', 'replying', 'processing', 'compacting', 'reading-memory', 'saving-memory',
  'deleting-memory', 'organizing-memory',
  'reading-file', 'saving-file', 'searching', 'reading-web', 'searching-files',
  'testing', 'checking', 'reviewing-memory', 'reviewing-files', 'reviewing-sources',
  'reviewing-checks',
] as const;
export type WorkingPhase = typeof WORKING_PHASES[number];
export function readWorkingPhase(value: unknown): WorkingPhase | null {
  return typeof value === 'string' && (WORKING_PHASES as readonly string[]).includes(value) ? value as WorkingPhase : null;
}

// These are runtime-owned status values, never assistant prose.
export function isCompactingWorkingStatus(status: unknown): boolean {
  return typeof status === 'string' && /^compacting(?: context)?(?:\.{3}|…)?$/i.test(status.trim());
}

export type PlainAgentPhase = WorkingPhase | 'waiting-input' | 'waiting-approval';

export function publicToolPhase(toolName: unknown, input: unknown): WorkingPhase {
  if (typeof toolName !== 'string') return 'processing';
  const args = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const parsed = parseToolName(toolName);
  const memoryTool = parsed.kind === 'mcp' && parsed.server === 'cindy_memory'
    ? parsed.tool === 'call_tool' ? args.name : parsed.tool : undefined;
  const action = toolName === 'bot_memory' ? args.action
    : typeof memoryTool === 'string'
      ? ({ memory_read: 'read', memory_search: 'search', memory_list: 'list', memory_write: 'write',
        memory_delete: 'delete', memory_review: 'review', memory_consolidate: 'consolidate' } as Record<string, string>)[memoryTool]
      : undefined;
  if (action === 'write') return 'saving-memory';
  if (action === 'delete') return 'deleting-memory';
  if (action === 'review') return 'reviewing-memory';
  if (action === 'consolidate') return 'organizing-memory';
  if (action === 'read' || action === 'search' || action === 'list') return 'reading-memory';
  // Reuse the existing deterministic command classifier, including its guards
  // against redirections, executable substitutions and mixed-action commands.
  // Strip free-form descriptions before classification; discard all targets.
  const descriptor = describeToolUse(toolName, { ...args, description: undefined });
  if (descriptor.kind === 'file') return descriptor.action === 'read' ? 'reading-file' : 'saving-file';
  if (descriptor.kind === 'fileChange') return 'saving-file';
  if (descriptor.kind === 'search') return 'searching-files';
  if (descriptor.kind === 'web') return descriptor.mode === 'search' ? 'searching' : 'reading-web';
  if (descriptor.kind === 'command') {
    switch (descriptor.intent?.action) {
      case 'read': return 'reading-file';
      case 'search': case 'list': case 'gitGrep': case 'gitLsFiles': return 'searching-files';
      case 'fetch': return 'reading-web';
      case 'test': return 'testing';
      case 'verify': case 'typecheck': case 'lint': case 'checkSyntax': case 'checkFormatting': return 'checking';
      default: return 'processing';
    }
  }
  return 'processing';
}

/** A returned tool is no longer executing. Retain only the public subject of
 * its feedback while the agent processes it; never claim the action succeeded.
 */
export function publicToolResultPhase(phase: WorkingPhase): WorkingPhase {
  switch (phase) {
    case 'reading-memory': case 'saving-memory': case 'deleting-memory':
    case 'organizing-memory': case 'reviewing-memory': return 'reviewing-memory';
    case 'reading-file': case 'saving-file': case 'searching-files': return 'reviewing-files';
    case 'reading-web': case 'searching': return 'reviewing-sources';
    case 'testing': case 'checking': return 'reviewing-checks';
    default: return 'processing';
  }
}

export function hasPublicWorkingSubject(phase: PlainAgentPhase): boolean {
  return phase !== 'compacting' && phase !== 'processing' && phase !== 'thinking' && phase !== 'replying'
    && phase !== 'waiting-input' && phase !== 'waiting-approval';
}

export const WORKING_PHASE_KEYS: Record<WorkingPhase, string> = {
  thinking: 'ccAgent.agentStatus.thinking', replying: 'ccAgent.agentStatus.replying',
  processing: 'ccAgent.agentStatus.processing', compacting: 'ccAgent.agentStatus.organizingConversation',
  'reading-memory': 'ccAgent.agentStatus.readingMemory', 'saving-memory': 'ccAgent.agentStatus.savingMemory',
  'deleting-memory': 'ccAgent.agentStatus.deletingMemory', 'organizing-memory': 'ccAgent.agentStatus.organizingMemory',
  'reading-file': 'ccAgent.agentStatus.readingFile', 'saving-file': 'ccAgent.agentStatus.savingFile',
  searching: 'ccAgent.agentStatus.searchingWeb', 'reading-web': 'ccAgent.agentStatus.readingWeb',
  'searching-files': 'ccAgent.agentStatus.searchingFiles', testing: 'ccAgent.agentStatus.testing',
  checking: 'ccAgent.agentStatus.checking', 'reviewing-memory': 'ccAgent.agentStatus.reviewingMemory',
  'reviewing-files': 'ccAgent.agentStatus.reviewingFiles', 'reviewing-sources': 'ccAgent.agentStatus.reviewingSources',
  'reviewing-checks': 'ccAgent.agentStatus.reviewingChecks',
};
