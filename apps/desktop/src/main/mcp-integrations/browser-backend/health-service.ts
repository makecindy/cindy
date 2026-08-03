import type {
  BrowserBackendHealth,
  BrowserBackendHealthReason,
  BrowserBackendRecoveryResult,
} from '../../../shared/browserBackend.js';
import type { BackendKind, BackendRequest, BackendResult } from './types.js';

interface HealthController {
  getCurrentBackendKind(): BackendKind;
  call(request: BackendRequest): Promise<BackendResult>;
  restartEmbedded(): Promise<boolean>;
  probeActiveControl(options?: { ensureHost?: boolean }): Promise<void>;
}

interface HealthLogger {
  warn(message: string, ...args: unknown[]): void;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function classifyFailure(
  message: string,
  fallback: BrowserBackendHealthReason,
  errorCode?: string,
): BrowserBackendHealthReason {
  if (
    errorCode === 'BROWSER_RUNTIME_UNAVAILABLE' ||
    /\b(?:disposing|restarting)\b|generation was replaced/i.test(message)
  ) {
    return 'disposing';
  }
  if (/host renderer|tab-op 'probe' timed out|ready timeout/i.test(message)) {
    return 'host-unavailable';
  }
  return fallback;
}

/**
 * Owns embedded-backend health and recovery policy separately from Electron
 * IPC registration. Recovery is single-flight so Settings remounts or repeat
 * clicks cannot race two replacement generations.
 */
export class BrowserBackendHealthService {
  private recoveryInFlight: {
    ensureHost: boolean;
    promise: Promise<BrowserBackendRecoveryResult>;
  } | null = null;
  private strictVerificationInFlight: Promise<BrowserBackendRecoveryResult> | null = null;

  constructor(
    private readonly controller: HealthController,
    private readonly logger: HealthLogger,
  ) {}

  async getHealth(): Promise<BrowserBackendHealth> {
    const health = await this.probe();
    if (health.status === 'error' && health.active === 'rsb-webview') {
      this.logger.warn('embedded browser health check failed; attempting automatic recovery', {
        reason: health.reason,
        errorCode: health.errorCode,
      });
      return (await this.recoverEmbedded(false)).health;
    }
    return health;
  }

  recover(): Promise<BrowserBackendRecoveryResult> {
    return this.recoverEmbedded(true);
  }

  private recoverEmbedded(ensureHost: boolean): Promise<BrowserBackendRecoveryResult> {
    if (this.strictVerificationInFlight) return this.strictVerificationInFlight;
    const current = this.recoveryInFlight;
    if (current) {
      if (!ensureHost || current.ensureHost) return current.promise;
      // A user-requested recovery is stronger than the passive Settings
      // check. Reuse the replacement work, then require the real configured
      // host/READY path before reporting success.
      const strict = current.promise
        .then((result) => this.verifyAfterPassiveRecovery(result));
      this.strictVerificationInFlight = strict;
      void strict.then(
        () => {
          if (this.strictVerificationInFlight === strict) {
            this.strictVerificationInFlight = null;
          }
        },
        () => {
          if (this.strictVerificationInFlight === strict) {
            this.strictVerificationInFlight = null;
          }
        },
      );
      return strict;
    }
    const promise = this.performRecovery(ensureHost);
    this.recoveryInFlight = { ensureHost, promise };
    void promise.then(
      () => {
        if (this.recoveryInFlight?.promise === promise) this.recoveryInFlight = null;
      },
      () => {
        if (this.recoveryInFlight?.promise === promise) this.recoveryInFlight = null;
      },
    );
    return promise;
  }

  private async verifyAfterPassiveRecovery(
    result: BrowserBackendRecoveryResult,
  ): Promise<BrowserBackendRecoveryResult> {
    if (
      result.health.active !== 'rsb-webview'
      || result.health.reason === 'start-failed'
      || result.health.reason === 'recovery-failed'
    ) {
      return result;
    }
    const health = await this.probe(true);
    return this.recoveryResult(health);
  }

  private async performRecovery(ensureHost: boolean): Promise<BrowserBackendRecoveryResult> {
    try {
      const restarted = await this.controller.restartEmbedded();
      if (!restarted) {
        return { ok: false, health: await this.probe(ensureHost) };
      }
      if (this.controller.getCurrentBackendKind() !== 'rsb-webview') {
        return { ok: false, health: await this.probe(ensureHost) };
      }
      const started = await this.controller.call({ action: 'start' });
      if (!started.ok) {
        this.logger.warn('embedded browser start failed after recovery', {
          errorCode: started.errorCode,
          message: started.message,
        });
        return {
          ok: false,
          health: this.failure('start-failed', started.errorCode),
        };
      }
      const health = await this.probe(ensureHost);
      return this.recoveryResult(health);
    } catch (err) {
      const message = errorText(err);
      this.logger.warn('embedded browser backend recovery failed', { err });
      const fallback = classifyFailure(message, 'recovery-failed');
      return { ok: false, health: this.failure(fallback) };
    }
  }

  private recoveryResult(health: BrowserBackendHealth): BrowserBackendRecoveryResult {
    return {
      ok: health.active === 'rsb-webview' && health.status === 'ready',
      // A concurrent Settings action may legitimately switch to the external
      // backend while embedded recovery is between serialized transitions.
      // Preserve that current, ready state instead of relabeling it as an
      // embedded recovery failure.
      health,
    };
  }

  private async probe(ensureHost = false): Promise<BrowserBackendHealth> {
    const active = this.controller.getCurrentBackendKind();
    // External Chrome has a separate availability/recovery UI. This contract
    // intentionally verifies only the embedded bridge.
    if (active !== 'rsb-webview') {
      return { active, status: 'ready', canRecover: false };
    }
    try {
      const status = await this.controller.call({ action: 'status' });
      if (!status.ok) {
        const message = status.message ?? 'browser status check failed';
        this.logger.warn('embedded browser local status check failed', {
          errorCode: status.errorCode,
          message,
        });
        return this.failure(
          classifyFailure(message, 'status-failed', status.errorCode),
          status.errorCode,
        );
      }
      // `status` is local-only. This handshake proves the live host renderer,
      // preload fan-out and RSB bridge can complete an actual round trip.
      await this.controller.probeActiveControl({ ensureHost });
      return { active, status: 'ready', canRecover: true };
    } catch (err) {
      const message = errorText(err);
      this.logger.warn('embedded browser control-path probe failed', { err });
      return this.failure(classifyFailure(message, 'status-failed'));
    }
  }

  private failure(
    reason: BrowserBackendHealthReason,
    errorCode?: string,
  ): BrowserBackendHealth {
    const active = this.controller.getCurrentBackendKind();
    return {
      active,
      status: 'error',
      canRecover: active === 'rsb-webview',
      reason,
      ...(errorCode ? { errorCode } : {}),
    };
  }
}
