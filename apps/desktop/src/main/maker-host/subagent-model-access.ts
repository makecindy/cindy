
// The access check itself lives in subagentModelAccessCore.ts (shared with the Node Host). This
// module builds the single Desktop instance; its ports resolve the Desktop key reader and provider
// service when called, never when this module loads.
import { createClaudeSubagentModelAccess } from './subagentModelAccessCore.js';
import { readClaudeApiKey } from './auth-adapters.js';
import { getDesktopProviderService } from './createDesktopProviderService.js';

const desktopSubagentModelAccess = createClaudeSubagentModelAccess({
  readClaudeApiKey: (...args) => readClaudeApiKey(...args),
  getDesktopProviderService: (...args) => getDesktopProviderService(...args),
});
type Instance = typeof desktopSubagentModelAccess;

export function resolveDesktopClaudeSubagentModelAccess(...args: Parameters<Instance['resolveDesktopClaudeSubagentModelAccess']>): ReturnType<Instance['resolveDesktopClaudeSubagentModelAccess']> {
  return desktopSubagentModelAccess.resolveDesktopClaudeSubagentModelAccess(...args);
}
