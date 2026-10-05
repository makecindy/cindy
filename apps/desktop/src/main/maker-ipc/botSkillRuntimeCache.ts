import { promises as fs, watch, type FSWatcher } from 'node:fs';
import path from 'node:path';

type Projection = {
  pluginRoot: string;
  artifacts?: string[];
  skills: { name: string; description: string; path: string; filePath: string }[];
};
type Entry = {
  revision: number;
  loadedRevision: number;
  stamp: string;
  watchers: FSWatcher[];
  value?: Projection;
  loading?: Promise<Projection>;
};
// Only small runtime projections are retained, never the complete source list.
// This bounds idle watcher handles across owners/bots without limiting Skills.
const entries = new Map<string, Entry>();
const MAX_CACHED_ROOTS = 32;
// Writer ownership outlives LRU entries: an evicted build can still rename its
// staged catalog. Queue replacements per root until that build has fully settled.
// Only pending work is retained here; idle roots still use the bounded LRU above.
const writers = new Map<string, Promise<Projection>>();

export function invalidateBotSkillRuntime(root: string): void {
  for (const key of [path.resolve(root), `${path.resolve(root)}\0query`]) {
    const entry = entries.get(key);
    if (entry) entry.revision++;
  }
}

function discard(root: string, entry: Entry) {
  if (entries.get(root) === entry) entries.delete(root);
  for (const watcher of entry.watchers) watcher.close();
  entry.watchers = [];
  entry.revision++;
}

/** Constant-size directory identity checks also detect delete/recreate and moves. */
async function sourceStamp(root: string, shelves: string[]): Promise<string> {
  const parent = await fs.stat(root).catch(() => null);
  const children = await Promise.all(shelves.map(shelf => fs.stat(path.join(root, shelf)).catch(() => null)));
  return `${parent?.dev}:${parent?.ino}/` + children.map(child => `${child?.dev}:${child?.ino}:${child?.mtimeMs}:${child?.ctimeMs}`).join('/');
}

/** Rebuild once per mutation, share concurrent hydrations, observe external edits. */
export async function cachedBotSkillRuntime(root: string, build: () => Promise<Projection>, kind: 'runtime' | 'query' = 'runtime'): Promise<Projection> {
  root = path.resolve(root);
  const key = kind === 'runtime' ? root : `${root}\0query`;
  const shelves = kind === 'runtime' ? ['skills'] : ['skills', 'disabled-skills'];
  const stamp = await sourceStamp(root, shelves);
  let entry = entries.get(key);
  if (!entry) {
    entry = { revision: 0, loadedRevision: -1, stamp: '', watchers: [] };
    entries.set(key, entry);
  }
  if (entry.stamp !== stamp || !entry.watchers.length) {
    // Reattach on directory replacement without forking an in-flight build.
    // Its revision loop incorporates mutations before publishing the result.
    entry.stamp = stamp;
    entry.revision++;
    for (const watcher of entry.watchers) watcher.close();
    entry.watchers = [];
    const observed = entry;
    try {
      // Do not watch the whole profile/workdir or generated catalog. The parent
      // watcher covers a missing/replaced skills directory; recursive watching
      // catches SKILL.md edits that do not change the directory timestamps.
      observed.watchers.push(watch(root, { persistent: false }, (_event, filename) => {
        if (!filename || shelves.includes(filename.toString())) observed.revision++;
      }));
      for (const shelf of shelves) try {
        observed.watchers.push(watch(path.join(root, shelf), { recursive: true, persistent: false }, (_event, filename) => {
          // Script outputs/venv caches do not alter the Skill metadata index.
          if (!filename || /^[^/\\]+(?:[/\\]skill\.md)?$/i.test(filename.toString())) observed.revision++;
        }));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      for (const watcher of observed.watchers) watcher.on('error', () => {
        for (const handle of observed.watchers) handle.close();
        observed.watchers = [];
        observed.revision++;
      });
    } catch {
      // Unwatchable roots/platforms must stay fresh, never silently cache forever.
      for (const watcher of observed.watchers) watcher.close();
      observed.watchers = [];
    }
  }
  // LRU eviction closes native handles; it does not remove any saved catalog.
  entries.delete(key);
  entries.set(key, entry);
  while (entries.size > MAX_CACHED_ROOTS) {
    const [oldRoot, oldEntry] = entries.entries().next().value!;
    discard(oldRoot, oldEntry);
  }
  const current = entry;
  if (current.loading) return structuredClone(await current.loading);
  if (current.watchers.length && current.value && current.loadedRevision === current.revision) {
    // Generated files are disposable: deleting them must rebuild the catalog.
    const artifacts = current.value.artifacts ?? (current.value.pluginRoot === root ? [] : [
      path.join(current.value.pluginRoot, 'catalog.jsonl'), current.value.skills[0].filePath,
      path.join(current.value.pluginRoot, '.claude-plugin', 'plugin.json'),
    ]);
    const present = await Promise.all(artifacts.map(file => fs.access(file))).then(() => true, () => false);
    // Eviction may happen while checking generated files. Rejoin the active
    // entry rather than enqueueing work from a now-discarded cache entry.
    if (entries.get(key) !== current) return cachedBotSkillRuntime(root, build, kind);
    if (present && current.loadedRevision === current.revision) return structuredClone(current.value);
    if (!present) current.revision++;
  }
  // Another hydration may have started rebuilding during the artifact check.
  if (current.loading) return structuredClone(await current.loading);
  const previous = writers.get(key);
  const loading = (async () => {
    // A failed predecessor has already cleaned up its staging files; it must
    // neither poison this retry nor race its final writes against this build.
    await previous?.catch(() => undefined);
    let value: Projection;
    let revision: number;
    do {
      revision = current.revision;
      value = await build();
    } while (revision !== current.revision && entries.get(key) === current);
    current.value = value;
    current.loadedRevision = revision;
    return structuredClone(value);
  })();
  current.loading = loading;
  writers.set(key, loading);
  try { return await loading; }
  catch (error) { discard(key, current); throw error; }
  finally {
    if (writers.get(key) === loading) writers.delete(key);
    current.loading = undefined;
  }
}
