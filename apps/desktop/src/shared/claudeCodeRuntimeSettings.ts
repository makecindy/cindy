export type ClaudeCodeRuntimeSource = 'managed' | 'system';

export interface ClaudeCodeRuntimeSettings {
  source: ClaudeCodeRuntimeSource;
  /** Empty means discover `claude` from the main process PATH. */
  customPath: string;
}

export type ClaudeCodeRuntimeFallbackReason =
  | 'not_found'
  | 'not_executable'
  | 'unsupported_launcher'
  | 'version_unavailable'
  | 'version_too_old';

export interface ClaudeCodeRuntimeDecision {
  requestedSource: ClaudeCodeRuntimeSource;
  /** Explicit executable path selected when this process started; null means PATH discovery. */
  requestedPath: string | null;
  activeSource: ClaudeCodeRuntimeSource;
  binaryPath: string | null;
  version: string | null;
  minimumVersion: string;
  fallbackReason?: ClaudeCodeRuntimeFallbackReason;
}

export interface ClaudeCodeRuntimeSettingsState {
  value: ClaudeCodeRuntimeSettings;
  isCustomized: boolean;
  decision: ClaudeCodeRuntimeDecision | null;
  restartRequired: boolean;
}

export interface ClaudeCodeRuntimeProbeResult {
  ok: boolean;
  binaryPath: string | null;
  version: string | null;
  minimumVersion: string;
  reason?: ClaudeCodeRuntimeFallbackReason;
}

export const DEFAULT_CLAUDE_CODE_RUNTIME_SETTINGS: ClaudeCodeRuntimeSettings = {
  source: 'managed',
  customPath: '',
};

export const MAX_CLAUDE_CODE_CUSTOM_PATH_LENGTH = 4096;

export function normalizeClaudeCodeRuntimeSettings(raw: unknown): ClaudeCodeRuntimeSettings {
  const value = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const source = value.source === 'system' ? 'system' : 'managed';
  const customPath =
    typeof value.customPath === 'string'
      ? value.customPath.trim().slice(0, MAX_CLAUDE_CODE_CUSTOM_PATH_LENGTH)
      : '';
  return { source, customPath };
}
