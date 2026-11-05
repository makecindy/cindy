import fs from 'node:fs';
import path from 'node:path';

import type { InstalledGhost } from '../../shared/ghost.js';
import { isValidPluginInstallRelId } from '../../shared/pluginIdentity.js';

/** Only discovery hints are retained. Delivery must still read the exact live approval. */
export class GhostNotificationIndex {
  private generation = 0;
  private snapshot: { generation: number; expires: number; ghosts: InstalledGhost[] } | null = null;
  private pending: { generation: number; promise: Promise<InstalledGhost[]> } | null = null;
  private rootsKey = '';
  private watchers: fs.FSWatcher[] = [];
  private watched = false;
  private watchEpoch = 0;

  constructor(private readonly deps: {
    roots(): string[];
    scan(): Promise<InstalledGhost[]>;
    now?: () => number;
  }) {}

  invalidate(): void {
    this.generation++;
    this.snapshot = null;
    this.pending = null;
  }

  dispose(): void {
    this.invalidate();
    this.closeWatchers();
    this.rootsKey = '';
  }

  private closeWatchers(): void {
    this.watchEpoch++;
    this.watched = false;
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
  }

  private observeRoots(): void {
    const roots = this.deps.roots();
    // Detect a replaced directory/ancestor even if its old watcher stays alive.
    const key = JSON.stringify(roots.map(root => {
      try {
        const stat = fs.lstatSync(root);
        return [root, stat.dev, stat.ino, stat.birthtimeMs, stat.isDirectory(), stat.isSymbolicLink()];
      } catch { return [root, null]; }
    }));
    if (this.watched && key === this.rootsKey) return;
    this.closeWatchers();
    this.invalidate();
    this.rootsKey = key;
    const epoch = this.watchEpoch;
    try {
      for (const [index, root] of roots.entries()) {
        const watcher = fs.watch(root, { recursive: true, persistent: false }, (_event, filename) => {
          if (epoch !== this.watchEpoch) return;
          if (filename === null || notificationDiscoveryFileChanged(index, String(filename))) this.invalidate();
        });
        watcher.on('error', () => {
          if (epoch !== this.watchEpoch) return;
          this.invalidate(); this.closeWatchers();
        });
        this.watchers.push(watcher);
      }
      this.watched = true;
    } catch {
      // Unsupported/unavailable watching preserves the previous fresh-scan behavior.
      this.closeWatchers();
    }
  }

  read(): Promise<InstalledGhost[]> {
    this.observeRoots();
    const now = this.deps.now?.() ?? Date.now();
    if (this.snapshot?.generation === this.generation && this.snapshot.expires > now) {
      return Promise.resolve(this.snapshot.ghosts);
    }
    if (this.pending?.generation === this.generation) return this.pending.promise;
    const generation = this.generation;
    const pending = { generation, promise: this.deps.scan().then(ghosts => {
      const candidates = ghosts.filter(ghost => ghost.enabled && ghost.manifest.subscribe?.topics?.length);
      // A scan racing a mutation/owner change never becomes the next event's index.
      // The caller rechecks every candidate and its approval before this event is sent.
      if (this.watched && generation === this.generation) {
        this.snapshot = { generation, ghosts: candidates, expires: (this.deps.now?.() ?? Date.now()) + 60_000 };
      }
      return candidates;
    }).finally(() => {
      if (this.pending === pending) this.pending = null;
    }) };
    this.pending = pending;
    return pending.promise;
  }
}

/** Watch installation facts, not plugin assets or skill projection bookkeeping. */
function notificationDiscoveryFileChanged(rootIndex: number, filename: string): boolean {
  const relative = filename.split(path.sep).join('/');
  if (relative === '' || relative === '_ns' || /^_ns\/[^/]+$/.test(relative)) return true;
  if (rootIndex === 0) {
    return (relative.endsWith('/.disabled') && isValidPluginInstallRelId(relative.slice(0, -'/.disabled'.length)))
      || isValidPluginInstallRelId(relative);
  }
  return relative.endsWith('.json') && isValidPluginInstallRelId(relative.slice(0, -5));
}
