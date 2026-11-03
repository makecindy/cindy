import type {
  BrowserExtensionStoreOpenResult,
  BrowserBackendHealth,
  BrowserBackendRecoveryResult,
  BrowserBackendSourceReadAccess,
} from '../../../shared/browserBackend.js';
import { isBrowserOpenForLoginErrorCode } from '../../../shared/browserBackend.js';
import {
  requireBoolean,
  requireEnum,
  requireObject,
  throwIpcError,
} from '../../utils/ipcValidate.js';
import { isRealProfileError } from '../browser-real-profile/types.js';
import type { BackendKind } from './types.js';

export interface BrowserBackendSettingsState {
  active: BackendKind;
  systemDefault: BackendKind;
  isOverride: boolean;
  useRealProfile: boolean;
}

export interface BrowserUseRealProfileResult {
  ok: true;
  enabled: boolean;
}

interface BrowserBackendIpcDeps<Event> {
  assertTrusted(event: Event): void;
  getState(): BrowserBackendSettingsState;
  setKind(kind: BackendKind): Promise<BackendKind>;
  setUseRealProfile(enabled: boolean): Promise<boolean>;
  reset(): Promise<BackendKind>;
  getHealth(): Promise<BrowserBackendHealth>;
  recover(): Promise<BrowserBackendRecoveryResult>;
  probeSourceRead(): BrowserBackendSourceReadAccess;
  openExtensionStore(): Promise<BrowserExtensionStoreOpenResult>;
}

/** Pure handler factory so trust gates and response contracts stay testable. */
export function createBrowserBackendIpcHandlers<Event>(deps: BrowserBackendIpcDeps<Event>) {
  return {
    getState(event: Event) {
      deps.assertTrusted(event);
      return deps.getState();
    },
    async setKind(event: Event, payload: unknown) {
      deps.assertTrusted(event);
      const obj = requireObject(payload, 'set-kind payload');
      const kind = requireEnum(obj.kind, ['external', 'rsb-webview', 'user-browser'] as const, 'kind');
      return { ok: true as const, active: await deps.setKind(kind) };
    },
    async setUseRealProfile(event: Event, payload: unknown) {
      deps.assertTrusted(event);
      const obj = requireObject(payload, 'set-use-real-profile payload');
      const enabled = requireBoolean(obj.enabled, 'enabled');
      try {
        return { ok: true as const, enabled: await deps.setUseRealProfile(enabled) };
      } catch (err) {
        // Known login-copy failures keep their code so Settings can say what went wrong.
        if (isRealProfileError(err) && isBrowserOpenForLoginErrorCode(err.code)) {
          throwIpcError(err.code, err.message);
        }
        throw err;
      }
    },
    async reset(event: Event) {
      deps.assertTrusted(event);
      return { ok: true as const, active: await deps.reset() };
    },
    getHealth(event: Event) {
      deps.assertTrusted(event);
      return deps.getHealth();
    },
    recover(event: Event) {
      deps.assertTrusted(event);
      return deps.recover();
    },
    probeSourceRead(event: Event) {
      deps.assertTrusted(event);
      return deps.probeSourceRead();
    },
    openExtensionStore(event: Event) {
      deps.assertTrusted(event);
      return deps.openExtensionStore();
    },
  };
}
