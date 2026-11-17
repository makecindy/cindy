/** Hidden, hot-reloaded override for ordinary local Claude runtime reclamation. */
import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { desktopMakerLogger } from './logger-adapter.js';

export const DEFAULT_CLAUDE_IDLE_MINUTES = 30;
export function normalizeClaudeIdleSettings(raw: unknown): { minutes: number } {
  const value = raw && typeof raw === 'object' ? (raw as { minutes?: unknown }).minutes : undefined;
  return { minutes: typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 1440
    ? value : DEFAULT_CLAUDE_IDLE_MINUTES };
}
const log = desktopMakerLogger.child('claude-idle-release-settings');
export function readClaudeIdleMinutes(): number {
  // This small override is read at scan/close boundaries. Do not cache by mtime:
  // editors can rewrite or replace it while preserving its timestamp and size.
  const file = path.join(app.getPath('userData'), 'claude-idle-release.json');
  try {
    return normalizeClaudeIdleSettings(JSON.parse(fs.readFileSync(file, 'utf-8'))).minutes;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn('Claude idle release settings unavailable; falling back to defaults');
    }
    return DEFAULT_CLAUDE_IDLE_MINUTES;
  }
}
