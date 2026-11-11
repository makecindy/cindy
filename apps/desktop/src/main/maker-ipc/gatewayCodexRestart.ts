import { DeferredCodexRestartService, type DeferredCodexRestartDeps } from './deferredCodexRestart.js';

export interface GatewayCodexRestartDeps {
  listHostKeys(): string[];
  restartHost(hostKey: string, stillValid: () => Promise<boolean>): Promise<void>;
  hasBusySession(hostKey: string): boolean;
  listSessionIds(hostKey: string): string[];
  onQueueGateReleased: NonNullable<DeferredCodexRestartDeps['onQueueGateReleased']>;
  logger?: DeferredCodexRestartDeps['logger'];
}

/** Reuse idle retry per gateway host so one busy host cannot delay other consumers. */
export class GatewayCodexRestartService {
  private readonly hosts = new Map<string, DeferredCodexRestartService>();

  constructor(private readonly deps: GatewayCodexRestartDeps) {}

  schedule(): void {
    for (const [key, service] of this.hosts) {
      if (!service.isPending()) this.hosts.delete(key);
    }
    for (const key of this.deps.listHostKeys()) {
      let service = this.hosts.get(key);
      if (!service) {
        service = new DeferredCodexRestartService({
          restart: (stillValid) => this.deps.restartHost(key, stillValid),
          hasBusyLocalCodexSession: () => this.deps.hasBusySession(key),
          listLocalCodexSessionIds: () => this.deps.listSessionIds(key),
          onQueueGateReleased: this.deps.onQueueGateReleased,
          logger: this.deps.logger,
        });
        this.hosts.set(key, service);
      }
      service.schedule('Cindy AI key changed');
    }
    // Keep credential persistence independent of host coordination. The caller
    // commits the matching endpoint before the guarded asynchronous refresh.
    queueMicrotask(() => this.onSessionSettled());
  }

  onSessionSettled(): void {
    for (const service of this.hosts.values()) service.onSessionSettled();
  }

  async flushBeforeLocalCodexSessionStart(): Promise<void> {
    await Promise.all([...this.hosts.values()].map(service => service.flushBeforeLocalCodexSessionStart()));
  }

  isSessionRestarting(sessionId: string): boolean {
    return [...this.hosts.values()].some(service => service.isSessionRestarting(sessionId));
  }

  clear(): void {
    for (const service of this.hosts.values()) service.clear();
    this.hosts.clear();
  }
}
