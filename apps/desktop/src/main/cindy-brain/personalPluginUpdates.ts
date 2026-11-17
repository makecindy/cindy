import fs from 'node:fs';
import path from 'node:path';
import { compareCindyVersions } from '@cindy/plugin-protocol';
import { z } from 'zod';
import type { InstalledGhost } from '../../shared/ghost.js';
import { installedGhostStoragePart } from '../../shared/pluginIdentity.js';
import { collectGhostContentFiles, hashGhostContentFiles, resolveGhostContentPath } from './ghostContentTree.js';

const entrySchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,127}$/),
  namespace: z.literal('local'), version: z.string().max(128),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export type PersonalPluginEntry = z.infer<typeof entrySchema>;
export interface PersonalPluginUpdateDeps {
  isCurrent(): boolean;
  findLocal(id: string): InstalledGhost | undefined;
  update(target: InstalledGhost, source: string, entry: PersonalPluginEntry): Promise<InstalledGhost>;
}
export async function personalPluginContentHash(directory: string): Promise<string> {
  const tree = await collectGhostContentFiles(directory, { dotEntries: 'skip', nonRegular: 'throw', label: 'personal plugin' });
  return hashGhostContentFiles(directory, tree.files, tree.rootIdentity);
}

/** No first installs, namespace migrations, permission grants or data copies.
 * Called only after the developer supervisor has committed a healthy app.
 * Each package uses the ordinary durable installer; later failures stop the batch
 * and are reported as partial, never described as an all-or-nothing rollback.
 */
export async function applyPersonalPluginUpdates(directory: string, deps: PersonalPluginUpdateDeps) {
  const results: Array<{ id: string; state: string; reason?: string; version?: string }> = [];
  if (!fs.existsSync(directory)) return { state: 'no-bundle', plugins: results };
  if (fs.lstatSync(directory).isSymbolicLink() || !fs.lstatSync(directory).isDirectory()) throw new Error('Invalid personal plugin root');
  const index = await resolveGhostContentPath(directory, 'index.json', { expect: 'file', label: 'personal plugin index' });
  if (fs.statSync(index).size > 1024 * 1024) throw new Error('Personal plugin index exceeds limit');
  const bundle = z.object({ version: z.literal(1), plugins: z.array(entrySchema).max(100) }).parse(JSON.parse(await fs.promises.readFile(index, 'utf8')));
  if (new Set(bundle.plugins.map(p => p.id)).size !== bundle.plugins.length) throw new Error('Duplicate personal plugin id');
  const sources = new Map<string, string>();
  // Validate the entire bundle before the first mutation.
  for (const entry of bundle.plugins) {
    const source = await resolveGhostContentPath(directory, entry.id, { expect: 'directory', label: 'personal plugin' });
    if (await personalPluginContentHash(source) !== entry.contentHash) throw new Error(`Personal plugin ${entry.id} changed after preparation`);
    sources.set(entry.id, source);
  }
  for (const entry of bundle.plugins) {
    if (!deps.isCurrent()) throw new Error('Personal plugin owner changed');
    const target = deps.findLocal(entry.id);
    if (!target || target.namespace !== 'local' || target.namespaceState !== 'confirmed' || target.approval.state !== 'approved') {
      results.push({ id: entry.id, state: 'deferred', reason: 'No approved, confirmed local installation; install through Cindy first' }); continue;
    }
    const order = compareCindyVersions(entry.version, target.manifest.version);
    if (order === null || order < 0) {
      results.push({ id: entry.id, state: 'deferred', reason: 'Invalid version or installed local version is newer' }); continue;
    }
    if (await personalPluginContentHash(target.dir) === entry.contentHash) {
      results.push({ id: entry.id, state: 'unchanged', version: entry.version }); continue;
    }
    try {
      const updated = await deps.update(target, sources.get(entry.id)!, entry);
      if (!deps.isCurrent() || updated.namespace !== 'local' || updated.manifest.id !== entry.id ||
          updated.manifest.version !== entry.version || installedGhostStoragePart(updated) !== installedGhostStoragePart(target) ||
          updated.enabled !== target.enabled || updated.approval.state !== 'approved') throw new Error('Installed personal plugin identity verification failed');
      results.push({ id: entry.id, state: 'updated', version: entry.version });
    } catch (error) {
      results.push({ id: entry.id, state: 'failed', reason: error instanceof Error ? error.message : String(error) });
      return { state: 'incomplete', plugins: results };
    }
  }
  return { state: results.some(p => p.state === 'deferred') ? 'deferred' : 'verified', plugins: results };
}
