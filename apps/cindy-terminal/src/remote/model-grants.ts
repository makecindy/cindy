import path from 'node:path';
import { isRemoteModelSelection, type RemoteModelSelection } from '@cindy/remote-agent/shared/remoteModelAccess';
import { atomicPrivateWrite, privateDirectory, readPrivateFile } from '../platform.js';

type Rule = { models?: string[]; members: Record<string, string[]> };
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Mirrors Desktop's provider/member intersection. No file means the existing
 * provider grant; unreadable permissions never become an unrestricted grant. */
export class TerminalRemoteModelGrants {
  private providers: Record<string, Rule> = {};
  private readonly owner: string | null;
  private readonly file: string;
  private readonly ready: Promise<void>;
  private writes = Promise.resolve();
  private closed = false;
  private loaded = false;
  constructor(profileDir: string, private readonly scope: () => string | null) {
    this.owner = scope(); this.file = path.join(profileDir, 'remote-model-access.json');
    this.ready = this.load();
  }
  private assertCurrent() { if (this.closed || this.scope() !== this.owner) throw new Error('OWNER_CHANGED'); }
  private async load() {
    await privateDirectory(path.dirname(this.file));
    const bytes = await readPrivateFile(this.file); if (!bytes) { this.loaded = true; return; }
    const value: unknown = JSON.parse(bytes.toString());
    if (!record(value) || !record(value.providers)) throw new Error('INVALID_REMOTE_MODEL_GRANTS');
    const providers: Record<string, Rule> = Object.create(null);
    for (const [id, input] of Object.entries(value.providers)) {
      if (!record(input) || !record(input.members) || ('models' in input && (!isRemoteModelSelection(input.models) || input.models === null))) throw new Error('INVALID_REMOTE_MODEL_GRANTS');
      const members: Record<string, string[]> = Object.create(null);
      for (const [memberId, models] of Object.entries(input.members)) {
        if (!isRemoteModelSelection(models) || models === null) throw new Error('INVALID_REMOTE_MODEL_GRANTS');
        members[memberId] = models;
      }
      providers[id] = { ...(Array.isArray(input.models) ? { models: input.models } : {}), members };
    }
    this.assertCurrent(); this.providers = providers; this.loaded = true;
  }
  async open() { await this.ready; this.assertCurrent(); }
  read(providerId: string, memberId?: string): { models: RemoteModelSelection; providerModels: RemoteModelSelection } {
    this.assertCurrent();
    if (!this.loaded) throw new Error('REMOTE_MODEL_GRANTS_NOT_LOADED');
    const rule = Object.hasOwn(this.providers, providerId) ? this.providers[providerId] : undefined;
    const providerModels = rule?.models ?? null;
    return { providerModels, models: memberId ? (rule && Object.hasOwn(rule.members, memberId) ? rule.members[memberId] : null) : providerModels };
  }
  allows(providerId: string, model: string, memberId?: string): boolean {
    try { const rule = this.read(providerId, memberId); return !!model && (rule.providerModels === null || rule.providerModels.includes(model)) && (rule.models === null || rule.models.includes(model)); }
    catch { return false; }
  }
  set(providerId: string, models: unknown, memberId: string | undefined, guard: () => void) {
    const job = this.writes.then(async () => {
      await this.ready; this.assertCurrent(); guard();
      if (!providerId || providerId.length > 256 || (memberId !== undefined && (!memberId || memberId.length > 256)) || !isRemoteModelSelection(models)) throw new Error('INVALID_REMOTE_MODEL_GRANTS');
      const providers = structuredClone(this.providers);
      const previous = Object.hasOwn(providers, providerId) ? providers[providerId] : undefined;
      const rule: Rule = { ...previous, members: { ...previous?.members } };
      if (memberId) { if (models === null) delete rule.members[memberId]; else Object.defineProperty(rule.members, memberId, { value: [...models], enumerable: true, writable: true, configurable: true }); }
      else if (models === null) delete rule.models; else rule.models = [...models];
      if (!rule.models && Object.keys(rule.members).length === 0) delete providers[providerId];
      else Object.defineProperty(providers, providerId, { value: rule, enumerable: true, writable: true, configurable: true });
      await atomicPrivateWrite(this.file, JSON.stringify({ providers }));
      this.assertCurrent(); guard(); this.providers = providers;
      return this.read(providerId, memberId);
    });
    this.writes = job.then(() => undefined, () => undefined); return job;
  }
  async close() { await this.writes; this.closed = true; }
}
