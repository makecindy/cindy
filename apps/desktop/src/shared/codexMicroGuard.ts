/** macOS protection that keeps Codex from opening the Work Louder HID service. */

export const CODEX_MICRO_GUARD_GET_STATE_CHANNEL = 'codex-micro-guard:get-state';
export const CODEX_MICRO_GUARD_SET_ENABLED_CHANNEL = 'codex-micro-guard:set-enabled';
export const CODEX_MICRO_GUARD_RECOVER_CHANNEL = 'codex-micro-guard:recover';
export const CODEX_MICRO_GUARD_STATE_CHANGED_CHANNEL = 'codex-micro-guard:state-changed';

export type CodexMicroGuardStatus =
  'unsupported' | 'disabled' | 'protecting' | 'intercepted' | 'recovery-required' | 'error';

export interface CodexMicroGuardState {
  supported: boolean;
  /** Machine-local override shared by Codex Micro and Creator Micro 2. Defaults to false. */
  enabled: boolean;
  status: CodexMicroGuardStatus;
  /** A running desktop Codex predates protection and has not applied it. */
  restartRequired?: boolean;
}
