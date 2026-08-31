import type { CodexMicroGuardState } from '../../shared/codexMicroGuard.js';
import { throwIpcError } from '../utils/ipcValidate.js';

export interface CodexMicroGuardIpcDeps {
  assertTrustedSender(event: unknown): void;
  getState(): Promise<CodexMicroGuardState>;
  setEnabled(enabled: boolean): Promise<CodexMicroGuardState>;
  recover(): Promise<CodexMicroGuardState>;
}

export function createCodexMicroGuardIpc(deps: CodexMicroGuardIpcDeps) {
  return {
    async get(event: unknown): Promise<CodexMicroGuardState> {
      deps.assertTrustedSender(event);
      try {
        return await deps.getState();
      } catch {
        throwIpcError('INTERNAL', 'Codex Micro guard state unavailable');
      }
    },

    async setEnabled(event: unknown, value: unknown): Promise<CodexMicroGuardState> {
      deps.assertTrustedSender(event);
      if (typeof value !== 'boolean') {
        throwIpcError('INVALID_PARAMS', 'Codex Micro guard enabled flag must be a boolean');
      }
      try {
        return await deps.setEnabled(value);
      } catch {
        throwIpcError('INTERNAL', 'Codex Micro guard update failed');
      }
    },

    async recover(event: unknown): Promise<CodexMicroGuardState> {
      deps.assertTrustedSender(event);
      try {
        return await deps.recover();
      } catch {
        throwIpcError('INTERNAL', 'Codex Micro guard recovery failed');
      }
    },
  };
}
