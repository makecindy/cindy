import type { ConfigFile } from '../types.js';
import { createClaudeCodeAdapter } from './claude-code.js';
import { createCodexAdapter } from './codex.js';
import type { AgentAdapter } from './types.js';

/**
 * Build an AgentAdapter from config. Shared between `update` and `refresh` so
 * adapter wiring stays in one place.
 */
export function makeAdapter(config: ConfigFile): AgentAdapter {
  switch (config.agent) {
    case 'claude-code':
      return createClaudeCodeAdapter({
        model: config.agent_options?.model,
        timeoutSeconds: config.agent_options?.timeout,
        refreshTimeoutSeconds: config.agent_options?.refreshTimeout,
        command: config.agent_options?.command,
      });
    case 'codex':
      return createCodexAdapter({
        model: config.agent_options?.model,
        timeoutSeconds: config.agent_options?.timeout,
        refreshTimeoutSeconds: config.agent_options?.refreshTimeout,
        command: config.agent_options?.command,
      });
    case 'custom':
      throw new Error(`agent "${config.agent}" is not implemented in MVP. Use "claude-code".`);
  }
}
