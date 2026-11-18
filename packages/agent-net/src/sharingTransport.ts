import type { Delegation, DeviceCertificate, GrantKind } from '@cindy/agent-net-protocol';
import type { AgentNetSigner } from './portableClient.js';
import { AgentNetSharingClient } from './sharingClient.js';

export interface SharingTransportScope {
  kind: GrantKind;
  resourceId: string;
  networkId: string;
  rootPublicKey: string;
  hostDeviceId: string;
  memberId: string;
  guestSubject: string;
}
export interface SharingTransportOptions {
  client: AgentNetSharingClient;
  applicant: AgentNetSigner;
  scope: SharingTransportScope;
  assertCurrent(): void;
  verifyCertificate(root: string, value: unknown): value is DeviceCertificate;
  verifyDelegation(root: string, value: unknown): value is Delegation;
}
/** One resource's possession-proved, host-signed lease. A relay never grants a
 * full device certificate to a visitor; its response must match every pin. */
export class AgentNetSharingTransport {
  private closed = false;
  private pending: Promise<Delegation> | null = null;
  private cached: Delegation | null = null;
  private controller: AbortController | null = null;
  constructor(private readonly options: SharingTransportOptions) {
    if (options.client.options.networkId !== options.scope.networkId || options.client.options.rootPublicKey !== options.scope.rootPublicKey)
      throw new Error('AGENT_NET_SHARING_SCOPE_MISMATCH');
  }
  private current(): void {
    if (this.closed) throw new Error('AGENT_NET_SHARING_CLOSED');
    this.options.assertCurrent();
  }
  private inspect(value: unknown): { id: string; delegation?: Delegation } {
    this.current();
    const r = value as { id?: unknown; status?: unknown; networkId?: unknown; rootPublicKey?: unknown;
      certificate?: DeviceCertificate; delegation?: Delegation } | null;
    const { scope, applicant } = this.options;
    if (!r || typeof r.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(r.id)
      || !['pending', 'ready'].includes(r.status as string) || r.rootPublicKey !== scope.rootPublicKey
      || r.networkId !== scope.networkId || !this.options.verifyCertificate(scope.rootPublicKey, r.certificate)
      || r.certificate.networkId !== scope.networkId || r.certificate.deviceId !== scope.hostDeviceId)
      throw new Error('UNTRUSTED_AGENT_NET_SHARING_TRANSPORT');
    if (r.status === 'pending') {
      if (r.delegation !== undefined) throw new Error('UNTRUSTED_AGENT_NET_SHARING_TRANSPORT');
      return { id: r.id };
    }
    const d = r.delegation;
    if (!this.options.verifyDelegation(scope.rootPublicKey, d) || d.id !== r.id || d.kind !== scope.kind
      || d.networkId !== scope.networkId || d.resourceId !== scope.resourceId || d.hostDeviceId !== scope.hostDeviceId
      || d.issuerCertificate.signature !== r.certificate.signature || d.guestDeviceId !== applicant.identity.deviceId
      || d.guestSigningKey !== applicant.identity.signingKey || d.guestTransportKey !== applicant.identity.transportKey
      || d.scope?.memberId !== scope.memberId || d.scope.guestSubject !== scope.guestSubject) throw new Error('UNTRUSTED_AGENT_NET_SHARING_TRANSPORT');
    // A ready old lease is not a successful renewal. Wait for the host's fresh
    // signature without causing a one-second reconnect loop near expiration.
    return d.expiresAt - Date.now() > 60_000 ? { id: r.id, delegation: d } : { id: r.id };
  }
  acquire(): Promise<Delegation> {
    this.current();
    if (this.cached && this.cached.expiresAt - Date.now() > 60_000) return Promise.resolve(this.cached);
    if (this.pending) return this.pending;
    const controller = new AbortController(); this.controller = controller;
    const timer = setTimeout(() => controller.abort(), 15_000);
    this.pending = this.acquireNow(controller.signal).then(d => { this.current(); this.cached = d; return d; })
      .finally(() => { clearTimeout(timer); this.pending = null; if (this.controller === controller) this.controller = null; });
    return this.pending;
  }
  private async acquireNow(signal: AbortSignal): Promise<Delegation> {
    const { client, applicant, scope } = this.options;
    const request = (path: string, body: unknown) => client.request(path, { method: 'POST', body, applicant, signal,
      isCurrent: () => { this.current(); return true; } });
    let response = this.inspect(await request('/api/agent-net/sharing/transport', {
      kind: scope.kind, resourceId: scope.resourceId, memberId: scope.memberId,
      signingKey: applicant.identity.signingKey, transportKey: applicant.identity.transportKey,
    }));
    const id = response.id;
    // Only an active connection attempt polls. Bounded exponential delays are
    // independent of UI renders, and close/account changes abort both I/O/wait.
    for (const delay of [250, 500, 1000, 2000, 4000]) {
      if (response.delegation) return response.delegation;
      await this.wait(delay, signal); this.current();
      response = this.inspect(await request('/api/agent-net/sharing/transport/status', {
        id, signingKey: applicant.identity.signingKey, transportKey: applicant.identity.transportKey,
      }));
      if (response.id !== id) throw new Error('AGENT_NET_SHARING_REQUEST_CHANGED');
    }
    if (response.delegation) return response.delegation;
    throw new Error('AGENT_NET_SHARING_HOST_UNAVAILABLE');
  }
  private wait(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(new Error('AGENT_NET_SHARING_ABORTED')); };
      const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
      if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
    });
  }
  close(): void { this.closed = true; this.cached = null; this.controller?.abort(); }
}
