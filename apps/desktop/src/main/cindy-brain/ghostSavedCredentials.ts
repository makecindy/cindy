import { isDeepStrictEqual } from 'node:util';
import { ghostNetworkHostPatternWithinCap, type GhostManifest } from '../../shared/ghost.js';
import { GHOST_SAVED_CREDENTIAL_MARKER, isReusableSavedSecret,
  type GhostAccountReuseGroup, type GhostAccountReuseResult, type GhostSavedCredentialReference,
  type GhostReusableSavedCredential } from '../../shared/pluginAccountReuse.js';
import type { GhostConnectionManager, GhostConnectionsVault } from './ghostConnections.js';

interface Deps {
  vault: Pick<GhostConnectionsVault, 'read' | 'store' | 'remove'>;
  connections: GhostConnectionManager;
  connectionSources(): readonly { instanceKey: string; name: string; manifest: GhostManifest }[];
  captureTarget(id: string): string | null;
  confirm(input: { instanceKey: string; secretKey: string; source: GhostReusableSavedCredential; hosts: string[] }): Promise<boolean>;
  withMutationLock<T>(id: string, task: () => T | Promise<T>): Promise<T>;
}

const referenceKey = (key: string) => `${key}-reused-credential`;

/** Existing owner-scoped vault, source catalogue and native confirmation; no
 * credential copies or grant store. The ordinary key carries a non-secret
 * marker so unused credentials keep their existing single-read path. */
export class GhostSavedCredentialManager {
  constructor(private readonly deps: Deps) {}

  private reference(id: string, key: string): GhostSavedCredentialReference | null {
    if (this.deps.vault.read(id, key) !== GHOST_SAVED_CREDENTIAL_MARKER) return null;
    try {
      const ref = JSON.parse(this.deps.vault.read(id, referenceKey(key)) ?? 'null') as GhostSavedCredentialReference | null;
      return ref && (ref.kind === 'secret' || ref.kind === 'connection') &&
        ['instanceKey', 'secretKey', 'accountId'].every(k => typeof ref[k as keyof typeof ref] === 'string' &&
          ref[k as keyof typeof ref].length > 0 && ref[k as keyof typeof ref].length <= 512) ? ref : null;
    } catch { return null; }
  }

  private candidate(id: string, key: string, ref: GhostSavedCredentialReference) {
    if (id === ref.instanceKey) return null;
    const sources = this.deps.connectionSources();
    const target = sources.find(item => item.instanceKey === id);
    const source = sources.find(item => item.instanceKey === ref.instanceKey);
    const targetSecret = target?.manifest.network?.secrets?.find(item => item.key === key && isReusableSavedSecret(item));
    if (!target || !source || !targetSecret) return null;
    const secret = source.manifest.network?.secrets?.find(item => item.key === ref.secretKey &&
      (isReusableSavedSecret(item) || item.source === 'gh-cli'));
    const connection = source.manifest.network?.connections?.find(item => item.key === ref.secretKey);
    const row = ref.kind === 'connection' && connection
      ? this.deps.connections.list(ref.instanceKey, ref.secretKey).find(item => item.id === ref.accountId) : null;
    const inject = ref.kind === 'secret' ? secret?.inject : connection?.inject;
    if (!inject || (ref.kind === 'secret' && ref.accountId !== 'saved') ||
        (ref.kind === 'connection' && !row) ||
        inject.header.toLowerCase() !== targetSecret.inject.header.toLowerCase() || inject.format !== targetSecret.inject.format ||
        !isDeepStrictEqual(targetSecret.exchange, ref.kind === 'secret' ? secret?.exchange : undefined)) return null;
    const hosts = targetSecret.inject.hosts ?? target.manifest.network!.hosts.filter(host => !host.includes('://'));
    const sourceHosts = row ? [row.host] : secret!.inject.hosts ?? source.manifest.network!.hosts.filter(host => !host.includes('://'));
    if (!hosts.length || !hosts.every(host => sourceHosts.some(cap => ghostNetworkHostPatternWithinCap(host, cap)))) return null;
    const value = row ? this.deps.connections.resolveTokenByHost(ref.instanceKey, ref.secretKey, row.host)
      : this.deps.vault.read(ref.instanceKey, ref.secretKey);
    // Never follow another reference or expose Host identity / OAuth / Node-only secrets.
    if (!value || value === GHOST_SAVED_CREDENTIAL_MARKER) return null;
    const option: GhostReusableSavedCredential = { ...ref, pluginName: source.name,
      label: row ? row.label ?? row.host : secret!.label, scopes: [] };
    return { value, hosts, option };
  }

  list(id: string, key: string): GhostAccountReuseGroup {
    const options: GhostReusableSavedCredential[] = [];
    for (const source of this.deps.connectionSources()) {
      if (source.instanceKey === id) continue;
      for (const secret of source.manifest.network?.secrets ?? []) {
        const found = this.candidate(id, key, { kind: 'secret', instanceKey: source.instanceKey, secretKey: secret.key, accountId: 'saved' });
        if (found) options.push(found.option);
      }
      for (const decl of source.manifest.network?.connections ?? []) {
        for (const row of this.deps.connections.list(source.instanceKey, decl.key)) {
          const found = this.candidate(id, key, { kind: 'connection', instanceKey: source.instanceKey, secretKey: decl.key, accountId: row.id });
          if (found) options.push(found.option);
        }
      }
    }
    const ref = this.reference(id, key);
    const resolved = ref ? this.candidate(id, key, ref) : null;
    return { key, label: key, options, accounts: ref ? [{ id: ref.accountId,
      label: resolved?.option.label ?? ref.secretKey, status: resolved ? 'connected' : 'expired' }] : [] };
  }

  async reuse(id: string, key: string, ref: GhostSavedCredentialReference): Promise<GhostAccountReuseResult> {
    const candidate = this.candidate(id, key, ref);
    const target = this.deps.captureTarget(id);
    const sourceTarget = this.deps.captureTarget(ref.instanceKey);
    if (!candidate || !target || !sourceTarget) return { ok: false, error: 'INVALID_CONFIG' };
    if (!await this.deps.confirm({ instanceKey: id, secretKey: key, source: candidate.option, hosts: candidate.hosts })) {
      return { ok: false, error: 'CANCELLED' };
    }
    return this.deps.withMutationLock(id, () => {
      const current = this.candidate(id, key, ref);
      if (target !== this.deps.captureTarget(id) || sourceTarget !== this.deps.captureTarget(ref.instanceKey) ||
          !current || !isDeepStrictEqual(candidate.hosts, current.hosts)) return { ok: false, error: 'INVALID_CONFIG' };
      const previous = this.deps.vault.read(id, referenceKey(key));
      if (!this.deps.vault.store(id, referenceKey(key), JSON.stringify(ref))) return { ok: false, error: 'VAULT_WRITE_FAILED' };
      if (!this.deps.vault.store(id, key, GHOST_SAVED_CREDENTIAL_MARKER)) {
        if (previous === null) this.deps.vault.remove(id, referenceKey(key));
        else this.deps.vault.store(id, referenceKey(key), previous);
        return { ok: false, error: 'VAULT_WRITE_FAILED' };
      }
      return { ok: true };
    });
  }

  resolve(id: string, key: string): { value: string; assertCurrent(): void } | null {
    const ref = this.reference(id, key);
    const candidate = ref ? this.candidate(id, key, ref) : null;
    const target = this.deps.captureTarget(id);
    const source = ref ? this.deps.captureTarget(ref.instanceKey) : null;
    if (!ref || !candidate || !target || !source) return null;
    return { value: candidate.value, assertCurrent: () => {
      if (target !== this.deps.captureTarget(id) || source !== this.deps.captureTarget(ref.instanceKey) ||
          !isDeepStrictEqual(ref, this.reference(id, key)) || !this.candidate(id, key, ref)) throw new Error('CREDENTIAL_REFERENCE_CHANGED');
    } };
  }

  disconnect(id: string, key: string, accountId: string): void {
    if (this.reference(id, key)?.accountId !== accountId) return;
    this.deps.vault.remove(id, key);
    this.deps.vault.remove(id, referenceKey(key));
  }
}
