import type { TFunction } from 'i18next';

const STATUS_KEYS = new Map<string, string>([
  ['thinking', 'ccAgent.agentStatus.thinking'],
  ['generating', 'ccAgent.agentStatus.generating'],
  ['editing files', 'ccAgent.agentStatus.editingFiles'],
  ['searching web', 'ccAgent.agentStatus.searchingWeb'],
  ['generating image', 'ccAgent.agentStatus.generatingImage'],
  ['compacting', 'ccAgent.agentStatus.compacting'],
  ['done', 'ccAgent.agentStatus.done'],
]);

function normalizeStaticStatus(status: string): string {
  return status
    .trim()
    .replace(/(?:\.{3}|…)$/, '')
    .toLowerCase();
}

/**
 * Localizes Cindy-owned Agent status chrome while preserving vendor/tool names
 * and arbitrary status text verbatim. Raw terminal stdout/stderr never passes
 * through this helper.
 */
export function localizeAgentStatus(status: string, t: TFunction): string {
  const staticKey = STATUS_KEYS.get(normalizeStaticStatus(status));
  if (staticKey) return t(staticKey);

  const runningTool = status.trim().match(/^(.+?) running(?:\.{3}|…)$/i);
  if (runningTool) {
    return t('ccAgent.agentStatus.runningTool', { tool: runningTool[1] });
  }

  return status;
}
