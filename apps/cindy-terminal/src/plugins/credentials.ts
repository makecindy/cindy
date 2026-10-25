import { isDeepStrictEqual } from 'node:util';
import { GhostOauthAccountManager, type GhostOauthAccountManagerDeps } from '@cindy/plugin-runtime/ghostOauthAccounts';
import { GhostConnectionManager } from '@cindy/plugin-runtime/ghostConnections';
import { handleGhostSecretsRequest } from '@cindy/plugin-runtime/ghostSecretsEndpoint';
import { handleGhostOauthRequest } from '@cindy/plugin-runtime/ghostOauthEndpoint';
import { handleGhostConnectionsRequest } from '@cindy/plugin-runtime/ghostConnectionsEndpoint';
import { ghostInstallApprovalToken, GHOST_NETWORK_MAX_CONNECTIONS_PER_DECL, type GhostManifest } from '@cindy/plugin-runtime/shared/ghost';
import { cancelActiveGhostOauthFlow } from '@cindy/plugin-runtime/ghostOauthFlow';
import { readBoundedBodyText } from '@cindy/plugin-runtime/ghostKvEndpoint';
import { installedGhostStoragePart } from '@cindy/plugin-runtime/shared/pluginIdentity';
import type { TerminalPlugins } from './host.js';

export type TerminalPluginCredentialOptions = Pick<GhostOauthAccountManagerDeps,
  'fetchImpl' | 'openExternal' | 'broker' | 'resolveBrokerPublicUrl' | 'isTokenBrokerAuthorized' | 'isHostPrimitiveAuthorized' | 'reclaimPort'> & {
  confirmAddHost(id: string, label: string, host: string): Promise<boolean>;
  getLoginEmail(): string | null;
};

/** Browser settings, TUI forms and runtime token injection share these exact
 * Desktop account managers. The vault adapter commits before reporting success. */
export class TerminalPluginCredentials {
  readonly oauth: GhostOauthAccountManager;
  readonly connections: GhostConnectionManager;
  private closed = false;
  private readonly abort = new AbortController();
  constructor(private readonly host: TerminalPlugins, private readonly options: TerminalPluginCredentialOptions) {
    const vault = {
      read: (id: string, key: string) => { this.guard(); return host.readSecretSync(id, key); },
      readStrict: (id: string, key: string) => { this.guard(); return host.readSecretSync(id, key); },
      store: (id: string, key: string, value: string) => {
        try { this.guard(); host.writeSecretSync(id, key, value); return true; } catch { return false; }
      },
      remove: (id: string, key: string) => { this.guard(); host.writeSecretSync(id, key, null); },
      readTail: (id: string, key: string) => { this.guard(); return host.secretTailSync(id, key); },
    };
    this.connections = new GhostConnectionManager({ vault });
    this.oauth = new GhostOauthAccountManager({ ...options, vault,
      fetchImpl: (url, init) => { this.guard(); return options.fetchImpl(url, { ...init, signal: AbortSignal.any([this.abort.signal, ...(init?.signal ? [init.signal] : [])]) }); },
      captureConnectTarget: id => this.target(id),
      isConnectTargetCurrent: (id, key, decl, expected) => {
        try {
          this.guard();
          if (expected !== undefined && expected !== this.target(id)) return false;
          const current = host.installed(id)?.manifest.network?.secrets?.find(secret => secret.key === key && secret.source === 'oauth')?.oauth;
          return current !== undefined && isDeepStrictEqual(current, decl);
        } catch { return false; }
      },
      withMutationLock: (id, task) => host.withCredentialMutation(id, task),
      onAccountConnected: () => host.credentialsChanged(),
      onAccountStatusChanged: () => host.credentialsChanged(),
    });
  }
  private guard() { if (this.closed) throw new Error('PLUGIN_CREDENTIALS_CLOSED'); }
  target(id: string): string | null {
    this.guard(); const ghost = this.host.installed(id);
    return ghost ? JSON.stringify([ghost.dir, ghostInstallApprovalToken(ghost.approval)]) : null;
  }
  prepareUpdate(id: string, before: GhostManifest, after: GhostManifest) {
    this.guard(); return this.oauth.prepareAccountsForChangedClients(before, after, id);
  }
  reconcile(id: string, manifest: GhostManifest) {
    this.guard(); return this.oauth.reconcileAccountsForInstalledManifestWithResult(manifest, id);
  }
  hostsFor(id: string) {
    this.guard(); const hosts = new Set<string>();
    for (const decl of this.host.installed(id)?.manifest.network?.connections ?? []) {
      for (const host of this.connections.hostsOf(id, decl.key)) hosts.add(host);
    }
    return [...hosts];
  }
  tokenFor(id: string, hostname: string) {
    this.guard();
    for (const decl of this.host.installed(id)?.manifest.network?.connections ?? []) {
      const value = this.connections.resolveTokenByHost(id, decl.key, hostname);
      if (value !== null) return { value, ...decl.inject };
    }
    return null;
  }
  async resolveOauthSecret(id: string, key: string, accountId?: string) {
    this.guard(); const secret = this.host.installed(id)?.manifest.network?.secrets?.find(secret => secret.key === key && secret.source === 'oauth');
    if (!secret?.oauth) return { ok: false as const, error: 'PLUGIN_SECRET_NOT_DECLARED' };
    return this.oauth.getFreshAccessToken(id, key, secret.oauth, accountId);
  }
  async request(id: string, request: Request, current: () => boolean, confirmConnection?: (label: string, host: string) => Promise<boolean>): Promise<Response | null> {
    const pathname = new URL(request.url).pathname;
    if (!/^\/(secrets|oauth|connections)(\/|$)/.test(pathname)) return null;
    this.guard(); const ghost = this.host.installed(id);
    if (!ghost) return new Response(null, { status: 404 });
    const target = this.target(id);
    const isCurrent = () => { try { return !this.closed && current() && this.target(id) === target; } catch { return false; } };
    const changed = () => this.host.credentialsChanged();
    const base = { ghostId: id, pathname, method: request.method, readBodyText: () => readBoundedBodyText(request), isCurrent };
    let outcome: { status: number; body?: string };
    const network = ghost.manifest.network;
    if (pathname === '/oauth' || pathname.startsWith('/oauth/')) {
      const oauthSecrets = new Map((network?.secrets ?? []).flatMap(secret => secret.source === 'oauth' && secret.oauth ? [[secret.key, secret.oauth] as const] : []));
      outcome = await handleGhostOauthRequest({ ...base, oauthSecrets, networkHosts: network?.hosts, manager: this.oauth,
        withMutationLock: (instance, task) => this.host.withCredentialMutation(instance, task),
        isTokenBrokerAuthorized: this.options.isTokenBrokerAuthorized ?? (() => false), onChanged: changed,
      });
    } else if (pathname === '/connections' || pathname.startsWith('/connections/')) {
      outcome = await this.host.withCredentialMutation(id, () => handleGhostConnectionsRequest({ ...base,
        decls: new Map((network?.connections ?? []).map(decl => [decl.key, { label: decl.label, maxConnections: decl.maxConnections ?? GHOST_NETWORK_MAX_CONNECTIONS_PER_DECL }])), manager: this.connections,
        confirmAddHost: (label, host) => confirmConnection ? confirmConnection(label, host) : this.options.confirmAddHost(id, label, host), onChanged: changed,
      }));
    } else {
      const keys = new Set((network?.secrets ?? []).filter(secret => ['user', 'gh-cli'].includes(secret.source ?? 'user')).map(secret => secret.key));
      for (const binding of ghost.manifest.node?.secretBindings ?? []) if (!binding.oauthSecret) keys.add(binding.key);
      outcome = await this.host.withCredentialMutation(id, () => handleGhostSecretsRequest({ ...base,
        userSecretKeys: [...keys], identitySecretKeys: (network?.secrets ?? []).filter(secret => secret.source === 'login-email').map(secret => secret.key),
        getLoginEmail: this.options.getLoginEmail,
        vault: {
          saved: (instance, key) => this.host.readSecretSync(instance, key) !== null,
          tail: (instance, key) => this.host.secretTailSync(instance, key),
          store: (instance, key, value) => { this.host.writeSecretSync(instance, key, value); return true; },
          remove: (instance, key) => this.host.writeSecretSync(instance, key, null),
        }, onStored: changed,
      }));
    }
    return new Response(outcome.body ?? null, { status: outcome.status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  }
  close() {
    this.closed = true; this.abort.abort(); cancelActiveGhostOauthFlow();
    for (const ghost of this.host.native.list()) this.oauth.invalidateGhost(installedGhostStoragePart(ghost));
  }
}
