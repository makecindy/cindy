import {
  formatCollabTargetsSummary,
  truncateToolText,
  type ToolUseDescriptor,
} from '@cindy/maker-shared';

/** Lightweight human-readable parameter shared by full tool rows and live previews. */
export interface DisplayParam {
  text: string;
  fullTitle?: string;
}

export interface DisplayParamOptions {
  /** 真实命令由独立次行展示时，不要再把它重复成首行参数。 */
  hideRawCommandFallback?: boolean;
}

/**
 * Tool input → concise human-readable label. Keeping this pure formatter shared
 * prevents the rolling live preview from drifting from AgentActionRow wording.
 *
 * - command with description: model-authored sentence, command kept as title;
 * - Codex command intent: intent target with the raw command/path in title;
 * - MCP / dynamic / collab: readable namespace and tool labels;
 * - file/search/web: the most useful target parameter.
 */
export function extractDisplayParam(
  descriptor: ToolUseDescriptor,
  options: DisplayParamOptions = {},
): DisplayParam | null {
  switch (descriptor.kind) {
    case 'command': {
      if (descriptor.description) {
        return {
          text: descriptor.description,
          ...(descriptor.command ? { fullTitle: descriptor.command } : {}),
        };
      }
      const intent = descriptor.intent;
      if (intent?.target && descriptor.command) {
        return {
          text: truncateToolText(intent.target, 60),
          fullTitle:
            intent.path && intent.path !== intent.target
              ? `${descriptor.command}\n${intent.path}`
              : descriptor.command,
        };
      }
      if (intent) return null;
      if (!descriptor.command) return null;
      if (options.hideRawCommandFallback) return null;
      return { text: truncateToolText(descriptor.command, 60), fullTitle: descriptor.command };
    }
    case 'file':
      return { text: descriptor.fileName, fullTitle: descriptor.filePath };
    case 'fileChange': {
      const change = descriptor.changes.length === 1 ? descriptor.changes[0] : null;
      if (!change) return null;
      if (change.action === 'move' && change.moveFileName && change.movePath) {
        return {
          text: `${change.fileName} → ${change.moveFileName}`,
          fullTitle: `${change.path} → ${change.movePath}`,
        };
      }
      return { text: change.fileName, fullTitle: change.path };
    }
    case 'search':
      return { text: descriptor.pattern };
    case 'web':
      return { text: descriptor.target };
    case 'todo':
      return null;
    case 'task':
      return descriptor.description ? { text: descriptor.description } : null;
    case 'mcp':
      return {
        text: `${descriptor.serverLabel} · ${descriptor.toolLabel}`,
        fullTitle: descriptor.detail
          ? `${descriptor.toolName}\n${descriptor.detail}`
          : descriptor.toolName,
      };
    case 'dynamic':
      return {
        text: descriptor.namespace
          ? `${descriptor.namespace} · ${descriptor.toolLabel}`
          : descriptor.toolLabel,
        fullTitle: descriptor.detail
          ? `${descriptor.toolName}\n${descriptor.detail}`
          : descriptor.toolName,
      };
    case 'collab': {
      if (descriptor.action === 'other') {
        return {
          text: descriptor.toolLabel,
          fullTitle: descriptor.detail
            ? `${descriptor.toolName}\n${descriptor.detail}`
            : descriptor.toolName,
        };
      }
      const targetSummary = formatCollabTargetsSummary(descriptor.targets, descriptor.targetCount);
      if (targetSummary) {
        const allTargets = descriptor.targets?.join(', ');
        const titleParts = [allTargets, descriptor.prompt].filter(Boolean);
        return {
          text: targetSummary,
          ...(titleParts.length > 0 ? { fullTitle: titleParts.join('\n') } : {}),
        };
      }
      if (descriptor.prompt) {
        return {
          text: truncateToolText(descriptor.prompt, 60),
          fullTitle: descriptor.prompt,
        };
      }
      return null;
    }
    case 'generic':
      return { text: descriptor.toolName };
  }
}
