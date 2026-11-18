/** Hidden, hot-reloaded override for ordinary local Claude runtime reclamation. */
import { app } from 'electron';
import { readClaudeIdleMinutesFrom } from './claudeIdleReleaseSettingsCore.js';

export { DEFAULT_CLAUDE_IDLE_MINUTES, normalizeClaudeIdleSettings } from './claudeIdleReleaseSettingsCore.js';
export function readClaudeIdleMinutes(): number {
  return readClaudeIdleMinutesFrom(app.getPath('userData'));
}
