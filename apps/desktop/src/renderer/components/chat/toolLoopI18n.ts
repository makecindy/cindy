import type { ToolLoopErrorDetails } from '@cindy/maker-core';

/**
 * The count has different meanings for each guard layer. Keep the mapping in
 * one place so live and persisted error surfaces cannot describe it wrongly.
 */
const TOOL_LOOP_I18N_KEYS: Record<ToolLoopErrorDetails['kind'], string> = {
  consecutive: 'logic.errors.toolUseLoopDetectedConsecutiveWithCount',
  pingpong: 'logic.errors.toolUseLoopDetectedPingPongWithCount',
  rotation: 'logic.errors.toolUseLoopDetectedRotationWithCount',
  contract: 'logic.errors.toolUseLoopDetectedWithCount',
};

export function getToolLoopI18nKey(toolLoop?: ToolLoopErrorDetails | null): string | undefined {
  return toolLoop?.count ? TOOL_LOOP_I18N_KEYS[toolLoop.kind] : undefined;
}
