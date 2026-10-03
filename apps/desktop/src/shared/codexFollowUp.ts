export type CodexFollowUpMode = 'queue' | 'steer';
export interface CodexFollowUpState {
  globalMode: CodexFollowUpMode;
  override: CodexFollowUpMode | null;
  effectiveMode: CodexFollowUpMode;
  isCustomized: boolean;
}
export function isCodexFollowUpMode(value: unknown): value is CodexFollowUpMode {
  return value === 'queue' || value === 'steer';
}
export function resolveCodexFollowUpMode(
  globalMode: CodexFollowUpMode,
  override?: CodexFollowUpMode | null,
): CodexFollowUpMode {
  return override ?? globalMode;
}

export function shouldAutoSteerCodex(input: {
  mode: CodexFollowUpMode | undefined;
  agentKind: string | null | undefined;
  source: string | undefined;
  orcaRole?: string | null;
  origin?: unknown;
  synthetic?: unknown;
  automatic?: boolean;
}): boolean {
  return (
    input.mode === 'steer' &&
    input.agentKind === 'codex' &&
    input.source === 'desktop' &&
    !input.orcaRole &&
    !input.origin &&
    !input.synthetic &&
    !input.automatic
  );
}
