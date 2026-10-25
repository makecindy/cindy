import type { ProviderListOptions } from '@cindy/app-runtime/providerService';
import { withoutProviderHeaderCredentials } from '@cindy/app-runtime/providerViewProjection';
import path from 'node:path';
import { REMOTE_AGENT_CHANNEL } from '@cindy/device-link';
import { createRemoteAgentHost, type RemoteAgentHostDeps, type RemoteAgentHost } from '@cindy/remote-agent';
import { resolveSharedProviderId } from '@cindy/remote-agent/host/providerAccess';
import { type ProviderView } from '@cindy/model-providers';
import { atomicPrivateWrite, privateDirectory, readPrivateFile } from '../platform.js';
import type { TerminalRemoteContext } from './types.js';

export interface TerminalRemoteAgentOptions {
  profileDir: string;
  getOwnerScope(): string | null;
  readProviders(options?: Partial<ProviderListOptions>): Promise<readonly ProviderView[]>;
  startHosted: RemoteAgentHostDeps['startHosted'];
  isAgentAvailable: RemoteAgentHostDeps['isAgentAvailable'];
  /** Shared memberships need their real isolation, outbound route, and model
   * grants. They cannot fall through to an owner's native credentials. */
  shared?: Pick<RemoteAgentHostDeps, 'providerAccess' | 'bindGuestProviderRoute' | 'groupRelay' | 'reshare' | 'recordGuestUsage' | 'purgeHostedTranscripts'>;
  bindOwnerProviderRoute?: RemoteAgentHostDeps['bindOwnerProviderRoute'];
  ownerModelAllowed?: RemoteAgentHostDeps['ownerModelAllowed'];
  modelAllowed?(providerId: string, model: string): boolean;
  forkHosted?: RemoteAgentHostDeps['forkHosted'];
  prepareImageEvent?: RemoteAgentHostDeps['prepareImageEvent'];
  imageArtifacts?: RemoteAgentHostDeps['imageArtifacts'];
  log?: RemoteAgentHostDeps['log'];
}

/** Uses the same host state machine as Desktop. Only authenticated invocation
 * contexts enter the controller registry; payload fields are never identity. */
export class TerminalRemoteAgentService {
  readonly channel = REMOTE_AGENT_CHANNEL;
  readonly host: RemoteAgentHost;
  private controllers = new Map<string, TerminalRemoteContext>();
  private allowed = new Set<string>();
  private writes: Promise<void> = Promise.resolve();
  private readonly ready: Promise<void>;
  private readonly owner: string | null;
  private closed = false;
  private readonly file: string;

  constructor(private readonly options: TerminalRemoteAgentOptions) {
    this.owner = options.getOwnerScope();
    this.file = path.join(options.profileDir, 'remote-provider-access.json');
    this.ready = this.load();
    const authorized = (controller: string) => {
      try {
        this.assertCurrent();
        const context = this.controllers.get(controller);
        if (!context || context.ownerScope !== this.owner) return false;
        context.assertCurrent();
        return context.source.kind === 'owner' || !!options.shared?.bindGuestProviderRoute;
      } catch { return false; }
    };
    this.host = createRemoteAgentHost({
      ...options.shared,
      startHosted: options.startHosted,
      isAgentAvailable: options.isAgentAvailable,
      ...(options.forkHosted ? { forkHosted: options.forkHosted } : {}),
      ...(options.bindOwnerProviderRoute ? { bindOwnerProviderRoute: options.bindOwnerProviderRoute } : {}),
      ...(options.ownerModelAllowed ? { ownerModelAllowed: options.ownerModelAllowed } : {}),
      ...(options.prepareImageEvent ? { prepareImageEvent: options.prepareImageEvent } : {}),
      ...(options.imageArtifacts ? { imageArtifacts: options.imageArtifacts } : {}),
      isControllerAuthorized: authorized,
      controllerTrust: controller => this.controllers.get(controller)?.source.kind === 'owner' ? 'owner' : 'guest',
      captureOwner: () => this.owner,
      isOwnerCurrent: owner => !this.closed && owner === this.owner && owner === options.getOwnerScope(),
      runsRoot: path.join(options.profileDir, 'remote-agent'),
      providerAccess: {
        resolve: async (kind, model, providerId, controller) => {
          await this.ready;
          if (!authorized(controller)) return null;
          if (this.controllers.get(controller)?.source.kind !== 'owner') {
            return options.shared?.providerAccess?.resolve(kind, model, providerId, controller) ?? null;
          }
          const views = await options.readProviders();
          if (!authorized(controller)) return null;
          return resolveSharedProviderId(views, id => this.allowed.has(id) && (options.modelAllowed?.(id, model) ?? true), kind, model, providerId);
        },
        isAllowed: (providerId, controller, model) => authorized(controller)
          && (this.controllers.get(controller)?.source.kind === 'owner'
            ? this.allowed.has(providerId) && (!model || (options.modelAllowed?.(providerId, model) ?? true))
            : options.shared?.providerAccess?.isAllowed(providerId, controller, model) === true),
        models: async (kind, providerId, controller) => {
          if (!authorized(controller)) return [];
          if (this.controllers.get(controller)?.source.kind !== 'owner') return options.shared?.providerAccess?.models?.(kind, providerId, controller) ?? [];
          const views = await options.readProviders();
          return authorized(controller) && this.allowed.has(providerId)
            ? views.find(view => view.id === providerId)?.models[kind]?.filter(model => !model.disabled && (options.modelAllowed?.(providerId, model.id) ?? true)).map(model => model.id) ?? [] : [];
        },
        restricted: (providerId, controller) => this.controllers.get(controller)?.source.kind !== 'owner'
          && (options.shared?.providerAccess?.restricted?.(providerId, controller) ?? true),
      },
      log: options.log,
    });
  }
  private assertCurrent(): void {
    if (this.closed || this.owner === null || this.owner !== this.options.getOwnerScope()) throw new Error('OWNER_CHANGED');
  }
  private async load(): Promise<void> {
    await privateDirectory(this.options.profileDir);
    const raw = await readPrivateFile(this.file);
    if (!raw) return;
    const input = JSON.parse(raw.toString()) as { version?: unknown; allowedProviders?: unknown };
    if (input.version !== 1 || !Array.isArray(input.allowedProviders) || input.allowedProviders.length > 4096
      || input.allowedProviders.some(value => typeof value !== 'string' || value.length > 256 || !value)) throw new Error('INVALID_REMOTE_PROVIDER_ACCESS');
    this.allowed = new Set(input.allowedProviders);
  }
  enabled(providerId: string): boolean { return !this.closed && this.allowed.has(providerId); }
  ownerController(controller:string):boolean{
    try{this.assertCurrent();const context=this.controllers.get(controller);context?.assertCurrent();return context?.source.kind==='owner';}catch{return false;}
  }
  async views(): Promise<ProviderView[]> {
    await this.ready; this.assertCurrent();
    const views = await this.options.readProviders({allowSideEffects:false}); this.assertCurrent();
    return views.map(view => ({ ...withoutProviderHeaderCredentials(view), remoteInvocationEnabled: this.allowed.has(view.id) }));
  }
  setEnabled(providerId: string, enabled: boolean, guard: () => void): Promise<void> {
    const pending = this.writes.then(async () => {
      await this.ready; this.assertCurrent(); guard();
      if (typeof providerId !== 'string' || !providerId || providerId.length > 256 || typeof enabled !== 'boolean') throw new Error('INVALID_REMOTE_PROVIDER_ACCESS');
      const views = await this.options.readProviders(); this.assertCurrent(); guard();
      if (!views.some(view => view.id === providerId)) throw new Error('PROVIDER_NOT_FOUND');
      const next = new Set(this.allowed);
      if (enabled) next.add(providerId); else next.delete(providerId);
      if (next.size > 4096) throw new Error('REMOTE_PROVIDER_LIMIT');
      await atomicPrivateWrite(this.file, JSON.stringify({ version: 1, allowedProviders: [...next] }));
      this.assertCurrent(); guard(); this.allowed = next;
      if (!enabled) await this.host.revalidateProviderAccess();
    });
    this.writes = pending.catch(() => undefined); return pending;
  }
  async request(value: unknown, context: TerminalRemoteContext): Promise<unknown> {
    await this.ready; this.assertCurrent(); context.assertCurrent();
    if (context.ownerScope !== this.owner || context.source.kind === 'shared-task') throw new Error('REMOTE_AGENT_ACCESS_DENIED');
    if (context.source.kind !== 'owner' && !this.options.shared?.bindGuestProviderRoute) throw new Error('REMOTE_AGENT_GUEST_ROUTE_REQUIRED');
    this.controllers.set(context.controllerDeviceId, context);
    const result = await this.host.handle(context.controllerDeviceId, value, context.signal);
    this.assertCurrent(); context.assertCurrent(); return result;
  }
  async stop(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.host.abortAll('app-quit'); await this.host.dispose();
    this.controllers.clear(); await this.writes;
  }
}
