import type { GhostHandoffFile, InstalledGhost } from '../../shared/ghost.js';
import { createHash } from 'node:crypto';
import { ghostInstallApprovalToken, GHOST_HANDOFF_MAX_BYTES_PER_FILE } from '../../shared/ghost.js';
import { hasPluginHostToolGroupApproval } from './taskCapability.js';
import { handoffDiskName, type GhostHandoffStore } from './handoffStore.js';
import { installedGhostStoragePart } from '../../shared/pluginIdentity.js';

export interface StorageSnapshot { name: string; bytes: Uint8Array }
export interface StorageSource { provider: string; path?: string; ref?: string; key?: string }

/** Host provider seam: implementations keep their own IO, persistence and
 * lifecycle. This service only routes; it never mirrors their data. */
export interface HostStorageProvider {
  readonly id: string;
  readonly operations: readonly string[];
  available(ghost: InstalledGhost): boolean;
  call(instance: string, request: Record<string, unknown>, assertCurrent: () => void): Promise<Record<string, unknown>>;
  snapshot?(instance: string, source: StorageSource, assertCurrent: () => void): Promise<StorageSnapshot>;
}

export interface StorageShareFacts {
  sourceId: string; sourceName: string; targetId: string; targetName: string; fileName: string; bytes: number;
}
export function storageShareMessage(t: (key: string) => string, facts: StorageShareFacts): string {
  const fields: Record<string, string> = { name: facts.sourceName, target: facts.targetName,
    file: facts.fileName, size: `${facts.bytes} B` };
  return t('settings.ghosts.perm.storageShareMessage').replace(/\{\{(name|target|file|size)\}\}/g, (_match, key: string) => fields[key]!);
}
interface Ports {
  ownerKey(): string;
  getGhost(id: string): InstalledGhost | null;
  listGhosts(): InstalledGhost[];
  providers: readonly HostStorageProvider[];
  handoff: Pick<GhostHandoffStore, 'hold' | 'assertQuota' | 'currentRoot' | 'import' | 'delete'>;
  confirmShare(facts: StorageShareFacts, current: () => boolean): Promise<boolean>;
}
const fail = (errorCode: string) => ({ ok: false as const, errorCode });

function shareBoundary(ghost: InstalledGhost): string | null {
  if (ghost.namespaceState !== 'confirmed') return null;
  return ghost.namespace === null || ghost.namespace === 'local' ? 'personal'
    : typeof ghost.namespace === 'string' ? `organization:${ghost.namespace}` : null;
}

/** Snapshots extend the existing handoff copies, without a live cross-plugin
 * mount, an ACL table or authority to read a different plugin's storage. */
export class HostStorageService {
  private readonly providers = new Map<string, HostStorageProvider>();
  private readonly sharing = new Set<string>();
  constructor(private readonly ports: Ports) {
    for (const provider of ports.providers) {
      if (this.providers.has(provider.id)) throw new Error('DUPLICATE_STORAGE_PROVIDER');
      this.providers.set(provider.id, provider);
    }
  }

  async request(id: string, input: Record<string, unknown>, pageCurrent: () => boolean): Promise<Record<string, unknown>> {
    const owner = this.ports.ownerKey(), ghost = this.ports.getGhost(id);
    const revision = ghostInstallApprovalToken(ghost?.approval);
    const current = () => {
      const latest = this.ports.getGhost(id);
      try { return pageCurrent() && this.ports.ownerKey() === owner && hasPluginHostToolGroupApproval(latest, 'storage') &&
        latest?.dir === ghost?.dir && ghostInstallApprovalToken(latest?.approval) === revision; } catch { return false; }
    };
    const check = () => { if (!current()) throw new Error('STORAGE_AUTHORIZATION_EXPIRED'); };
    if (!ghost || !current()) return fail('PERMISSION_DENIED');
    try {
      if (input.op === 'providers') return { ok: true, providers: [...this.providers.values()]
        .filter(provider => provider.available(ghost)).map(provider => ({ id: provider.id, operations: [...provider.operations], snapshot: !!provider.snapshot })) };
      if (input.op === 'targets') {
        const boundary = shareBoundary(ghost);
        if (!boundary) return fail('PERMISSION_DENIED');
        const targets = this.ports.listGhosts().filter(target => installedGhostStoragePart(target) !== id &&
          hasPluginHostToolGroupApproval(target, 'storage') && shareBoundary(target) === boundary)
          .map(target => ({ id: installedGhostStoragePart(target), name: target.manifest.name }));
        check(); return { ok: true, targets };
      }
      if (input.op === 'call') {
        const provider = typeof input.provider === 'string' ? this.providers.get(input.provider) : undefined;
        const request = input.request;
        if (!provider?.available(ghost)) return fail('UNSUPPORTED_PROVIDER');
        if (!request || typeof request !== 'object' || Array.isArray(request) ||
          !provider.operations.includes(String((request as Record<string, unknown>).op))) return fail('INVALID_REQUEST');
        check();
        const result = await provider.call(id, request as Record<string, unknown>, check);
        check();
        return result;
      }
      if (input.op !== 'share' || typeof input.targetPluginId !== 'string' || input.targetPluginId === id ||
          !input.source || typeof input.source !== 'object' || Array.isArray(input.source)) return fail('INVALID_REQUEST');
      if (this.sharing.has(id)) return fail('BUSY');
      const targetId = input.targetPluginId, target = this.ports.getGhost(targetId);
      const targetRevision = ghostInstallApprovalToken(target?.approval);
      const boundary = shareBoundary(ghost);
      if (!target || !boundary || shareBoundary(target) !== boundary || !hasPluginHostToolGroupApproval(target, 'storage')) return fail('PERMISSION_DENIED');
      const source = input.source as StorageSource;
      const provider = this.providers.get(source.provider);
      if (!provider?.available(ghost) || !provider.snapshot) return fail('UNSUPPORTED_PROVIDER');
      const sharedCurrent = () => {
        const latest = this.ports.getGhost(targetId);
        return current() && latest?.dir === target.dir && ghostInstallApprovalToken(latest?.approval) === targetRevision &&
          hasPluginHostToolGroupApproval(latest, 'storage') && shareBoundary(latest!) === boundary &&
          shareBoundary(this.ports.getGhost(id)!) === boundary;
      };
      const checkShare = () => { if (!sharedCurrent()) throw new Error('STORAGE_AUTHORIZATION_EXPIRED'); };
      this.sharing.add(id);
      try {
        const selected = await provider.snapshot(id, source, checkShare);
        const snapshot = { ...selected, name: handoffDiskName(selected.name) };
        checkShare();
        if (snapshot.bytes.byteLength > GHOST_HANDOFF_MAX_BYTES_PER_FILE) return fail('FILE_TOO_LARGE');
        const digest = createHash('sha256').update(snapshot.bytes).digest('hex');
        await this.ports.handoff.assertQuota(targetId, [snapshot.bytes.byteLength]);
        checkShare();
        if (!await this.ports.confirmShare({ sourceId: id, sourceName: ghost.manifest.name,
          targetId, targetName: target.manifest.name, fileName: snapshot.name, bytes: snapshot.bytes.byteLength }, sharedCurrent)) return fail('PERMISSION_DENIED');
        checkShare();
        const fresh = await provider.snapshot(id, source, checkShare);
        checkShare();
        if (handoffDiskName(fresh.name) !== snapshot.name || createHash('sha256').update(fresh.bytes).digest('hex') !== digest) return fail('STALE_RESOURCE');
        const releaseSource = this.ports.handoff.hold(id);
        if (!releaseSource) return fail('BUSY');
        const releaseTarget = this.ports.handoff.hold(targetId);
        if (!releaseTarget) { releaseSource(); return fail('BUSY'); }
        const root = this.ports.handoff.currentRoot();
        let copies: GhostHandoffFile[] | undefined;
        try {
          copies = await this.ports.handoff.import(targetId, [snapshot], checkShare, root);
          checkShare();
          return { ok: true, op: 'share', targetPluginId: targetId, files: copies };
        } catch {
          // Use the captured original root for compensation after owner change.
          // Failed import can already have published a copy; never invite replay.
          if (copies) await Promise.allSettled(copies.map(file => this.ports.handoff.delete(targetId, file.ref, root)));
          return { ...fail('SHARE_RESULT_UNKNOWN'), targetPluginId: targetId,
            file: { name: snapshot.name, size: snapshot.bytes.byteLength, sha256: digest } };
        } finally { releaseTarget(); releaseSource(); }
      } finally { this.sharing.delete(id); }
    } catch { return fail(current() ? 'STORAGE_OPERATION_FAILED' : 'PERMISSION_DENIED'); }
  }
}
