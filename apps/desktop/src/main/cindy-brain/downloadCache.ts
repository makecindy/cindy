import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

interface Receipt {
  dir: string;
  scope: string;
  plugin: string;
  approval: string;
  size: number;
  ino: number;
  mtimeMs: number;
}

/** One owner-wide disk budget. Mutations serialize; network and Node execution do not. */
export class PluginDownloadCache {
  private tail: Promise<unknown> = Promise.resolve();
  private reserved = new Map<string, number>();
  private pins = new Map<string, number>();
  private receipts = new Map<string, Receipt>();
  constructor(private limit = 4 * 1024 ** 3) {}
  revokeAll() {
    this.receipts.clear();
  }

  private async locked<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work);
    this.tail = result.catch(() => {});
    return result;
  }
  private forget(dir: string) {
    for (const [token, receipt] of this.receipts)
      if (receipt.dir === dir) this.receipts.delete(token);
  }
  async reserve(root: string, dir: string, bytes: number): Promise<void> {
    return this.locked(async () => {
      await fs.mkdir(root, { recursive: true });
      if ((await fs.realpath(root)) !== path.resolve(root)) throw Error('Unsafe cache root');
      const entries: Array<{ dir: string; bytes: number; time: number }> = [];
      for (const plugin of await fs.readdir(root, { withFileTypes: true })) {
        if (!plugin.isDirectory()) throw Error('Unsafe download cache');
        const pluginRoot = path.join(root, plugin.name);
        for (const artifact of await fs.readdir(pluginRoot, { withFileTypes: true })) {
          if (!artifact.isDirectory() || !/^[a-f0-9]{64}$/.test(artifact.name))
            throw Error('Unsafe download cache');
          const entryDir = path.join(pluginRoot, artifact.name);
          let size = 0,
            time = 0;
          for (const name of await fs.readdir(entryDir)) {
            const stat = await fs.lstat(path.join(entryDir, name));
            if (!stat.isFile()) throw Error('Unsafe download cache');
            size += stat.size;
            time = Math.max(time, stat.mtimeMs);
          }
          // Charge directory/receipt overhead too: empty failed attempts are not free forever.
          entries.push({
            dir: entryDir,
            bytes: Math.max(size + 65536, this.reserved.get(entryDir) ?? 0),
            time,
          });
        }
      }
      // Reserve before dispatch: concurrent queued downloads cannot oversubscribe disk.
      const planned = Math.max(bytes + 65536, entries.find((e) => e.dir === dir)?.bytes ?? 0);
      let total = entries.filter((e) => e.dir !== dir).reduce((sum, e) => sum + e.bytes, planned);
      for (const entry of entries.sort((a, b) => a.time - b.time)) {
        if (total <= this.limit) break;
        if (entry.dir === dir || this.reserved.has(entry.dir) || this.pins.has(entry.dir)) continue;
        await fs.rm(entry.dir, { recursive: true, force: true });
        this.forget(entry.dir);
        total -= entry.bytes;
      }
      if (total > this.limit) throw Error('Download cache is full');
      await fs.mkdir(dir, { recursive: true });
      if ((await fs.realpath(dir)) !== path.resolve(dir)) throw Error('Unsafe cache directory');
      this.reserved.set(dir, planned);
    });
  }
  release(dir: string) {
    this.reserved.delete(dir);
  }
  async issue(dir: string, scope: string, plugin: string, approval: string): Promise<string> {
    return this.locked(async () => {
      const file = path.join(dir, 'artifact');
      const now = new Date();
      await fs.utimes(file, now, now);
      const stat = await fs.lstat(file);
      if (!stat.isFile() || (await fs.realpath(file)) !== file) throw Error('Unsafe artifact');
      // One reusable receipt per resident artifact, not one per cache hit.
      for (const [token, receipt] of this.receipts) {
        if (
          receipt.dir === dir &&
          receipt.scope === scope &&
          receipt.plugin === plugin &&
          receipt.approval === approval
        ) {
          Object.assign(receipt, { size: stat.size, ino: stat.ino, mtimeMs: stat.mtimeMs });
          return token;
        }
      }
      this.forget(dir);
      const token = randomUUID();
      this.receipts.set(token, {
        dir,
        scope,
        plugin,
        approval,
        size: stat.size,
        ino: stat.ino,
        mtimeMs: stat.mtimeMs,
      });
      return token;
    });
  }
  async acquire(token: string, scope: string, plugin: string, approval: string) {
    return this.locked(async () => {
      const receipt = this.receipts.get(token);
      if (
        !receipt ||
        receipt.scope !== scope ||
        receipt.plugin !== plugin ||
        receipt.approval !== approval
      )
        throw Error('Invalid download receipt');
      const file = path.join(receipt.dir, 'artifact');
      const stat = await fs.lstat(file);
      if (
        !stat.isFile() ||
        stat.size !== receipt.size ||
        stat.ino !== receipt.ino ||
        stat.mtimeMs !== receipt.mtimeMs ||
        (await fs.realpath(file)) !== file
      )
        throw Error('Artifact changed');
      const now = new Date();
      await fs.utimes(file, now, now);
      receipt.mtimeMs = (await fs.stat(file)).mtimeMs;
      if (this.receipts.get(token) !== receipt) throw Error('Download receipt revoked');
      this.pins.set(receipt.dir, (this.pins.get(receipt.dir) ?? 0) + 1);
      let released = false;
      return {
        path: file,
        release: () => {
          if (released) return;
          released = true;
          const count = (this.pins.get(receipt.dir) ?? 1) - 1;
          if (count) this.pins.set(receipt.dir, count);
          else this.pins.delete(receipt.dir);
        },
      };
    });
  }
  async removePlugin(root: string): Promise<void> {
    return this.locked(async () => {
      for (const [token, receipt] of this.receipts)
        if (path.dirname(receipt.dir) === root) this.receipts.delete(token);
      // Caller has stopped the Node runtime and settled downloads before entering.
      await fs.rm(root, { recursive: true, force: true });
    });
  }
}
