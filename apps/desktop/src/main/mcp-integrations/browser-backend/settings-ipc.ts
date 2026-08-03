import type {
  BrowserBackendHealth,
  BrowserBackendRecoveryResult,
} from '../../../shared/browserBackend.js';
import { requireEnum, requireObject } from '../../utils/ipcValidate.js';
import type { BackendKind } from './types.js';

export interface BrowserBackendSettingsState {
  active: BackendKind;
  systemDefault: BackendKind;
  isOverride: boolean;
}

interface BrowserBackendIpcDeps<Event> {
  assertTrusted(event: Event): void;
  getState(): BrowserBackendSettingsState;
  setKind(kind: BackendKind): Promise<BackendKind>;
  reset(): Promise<BackendKind>;
  getHealth(): Promise<BrowserBackendHealth>;
  recover(): Promise<BrowserBackendRecoveryResult>;
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
      const kind = requireEnum(obj.kind, ['external', 'rsb-webview'] as const, 'kind');
      return { ok: true as const, active: await deps.setKind(kind) };
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
  };
}
