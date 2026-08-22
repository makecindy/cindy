/**
 * 搜索模式 Claude hooks：帮手 / 插件 / Skill 真拒绝。
 */

import type {
  HookCallback,
  HookCallbackMatcher,
  HookEvent,
  PreToolUseHookInput,
} from '@anthropic-ai/claude-agent-sdk';
import type { Logger } from '@cindy/maker-core';

import { isSearchRitualTool } from '../../../shared/searchMode.js';

const SEARCH_MODE_DENY_REASON =
  'Search mode is on. Use WebSearch / WebFetch only. Helpers, plugins, skills, and browser tools are blocked.';

export function createSearchModeHooks(
  deps: {
    resolveCindySessionId: (sdkSessionId: string) => string | null;
    isSearchModeEnabled: (sessionId: string) => Promise<boolean>;
  },
  logger: Logger,
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  const log = logger.child('hook/search-mode');

  const enabledFor = async (sdkSessionId: string | undefined): Promise<boolean> => {
    if (!sdkSessionId) return false;
    const sessionId = deps.resolveCindySessionId(sdkSessionId);
    if (!sessionId) return false;
    try {
      return await deps.isSearchModeEnabled(sessionId);
    } catch (err) {
      log.warn('search mode lookup failed; denying ritual tools', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      return true;
    }
  };

  const denyRitual: HookCallback = async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return { continue: true };
    const pre = input as PreToolUseHookInput;
    if (!isSearchRitualTool(pre.tool_name)) return { continue: true };
    if (!(await enabledFor(pre.session_id))) return { continue: true };
    return {
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: SEARCH_MODE_DENY_REASON,
      },
    };
  };

  return {
    PreToolUse: [{ hooks: [denyRitual] }],
  };
}
