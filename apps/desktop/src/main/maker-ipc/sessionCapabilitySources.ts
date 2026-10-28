import { createHash } from 'node:crypto';
import { promises as fs, watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import type { CapabilityResourceSnapshot } from './sessionCapabilityMonitor.js';
import type { RemoteFileBrowserManager } from '../file-browser/remote.js';
import type { collectPersonalConfig, collectProjectInstructionFiles } from '../remote-agent/controller/projectFiles.js';
import type { AgentKind } from '@cindy/maker-core';

/** A device-hosted model receives the controller's collected files and bridge,
 * rather than that model computer's personal configuration. Match that exact
 * collection contract, including the credential exclusions on shared devices. */
export async function readForwardedCapabilitySnapshot(
  source: { agentKind: AgentKind; workDir: string },
  deps: {
    collectProject: typeof collectProjectInstructionFiles;
    collectPersonal: typeof collectPersonalConfig;
    skipCredentials: boolean;
    homeDir: string;
    codexHome: string;
    mcpCatalog: unknown;
  },
): Promise<CapabilityResourceSnapshot> {
  const options = { skipCredentials: deps.skipCredentials };
  const project = await deps.collectProject(source.workDir, options);
  const personal = await deps.collectPersonal(source.agentKind, project, options);
  const isSkill = (name: string) => /(^|\/)(skills|commands)\//.test(name);
  const skillRoots = personal.roots.filter(root => isSkill(`${root.relative}/`));
  const mcpRevision = createHash('sha256').update(JSON.stringify(deps.mcpCatalog)).digest('hex');
  return {
    revision: createHash('sha256').update(JSON.stringify({
      project: project.filter(file => isSkill(file.path)),
      personal: personal.personal.files.filter(file => isSkill(file.path)), skillRoots, mcpRevision,
    })).digest('hex'),
    mcpRevision,
    watchPaths: [
      ...skillRoots.map(root => root.local),
      path.join(deps.homeDir, '.agents', 'skills'),
      path.join(deps.homeDir, '.claude', 'skills'),
      path.join(deps.homeDir, '.claude', 'commands'),
      path.join(deps.codexHome, 'skills'),
      ...['.agents/skills', '.claude/skills', '.claude/commands', '.codex/skills', '.pi/skills']
        .map(root => path.join(source.workDir, root)),
    ],
  };
}

/** Files are read only into a digest. No config, credentials or Skill text leave
 * main, and a file changing during a read never becomes a successful snapshot. */
export async function readCapabilityFiles(
  catalog: unknown,
  files: readonly string[],
  watchPaths: readonly string[],
  select: (file: string, content: Buffer) => string | Buffer = (_file, content) => content,
): Promise<CapabilityResourceSnapshot> {
  const hash = createHash('sha256').update(JSON.stringify(catalog));
  for (const file of [...new Set(files)].sort()) {
    hash.update(file);
    try {
      const before = await fs.stat(file, { bigint: true });
      const content = await fs.readFile(file);
      const after = await fs.stat(file, { bigint: true });
      if (before.dev !== after.dev || before.ino !== after.ino
        || before.mtimeNs !== after.mtimeNs || before.size !== after.size) {
        throw new Error('Capability source changed during discovery');
      }
      hash.update(select(file, content));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      hash.update('\0absent');
    }
  }
  return { revision: hash.digest('hex'), watchPaths };
}

/** Watch only declared resource roots. If a root is absent, observe creation
 * from its nearest existing parent without recursively watching the project. */
export async function watchCapabilityPaths(roots: readonly string[], changed: () => void): Promise<() => void> {
  let closed = false;
  let watchers: FSWatcher[] = [];
  let generation = 0;
  async function attach() {
    const ownGeneration = ++generation;
    const next: FSWatcher[] = [];
    for (const root of new Set(roots)) {
      let existing = root;
      let recursive = true;
      for (;;) {
        try {
          const stat = await fs.stat(existing);
          if (!stat.isDirectory()) { recursive = false; existing = path.dirname(existing); }
          break;
        }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') break;
          recursive = false;
          const parent = path.dirname(existing);
          if (parent === existing) break;
          existing = parent;
        }
      }
      if (closed || generation !== ownGeneration) break;
      try {
        const listener = watch(existing, { recursive, persistent: false }, (event, name) => {
          if (closed || generation !== ownGeneration) return;
          const candidate = name ? path.resolve(existing, String(name)) : existing;
          const relative = path.relative(root, candidate);
          const ancestor = path.relative(candidate, root);
          if ((!relative.startsWith(`..${path.sep}`) && relative !== '..')
            || (!ancestor.startsWith(`..${path.sep}`) && ancestor !== '..')) {
            changed();
            if (!recursive || event === 'rename') void attach();
          }
        });
        listener.on('error', () => { if (!closed) changed(); });
        next.push(listener);
      } catch { /* Before-send comparison remains authoritative if OS watch is unavailable. */ }
    }
    if (closed || generation !== ownGeneration) {
      next.forEach(watcher => watcher.close());
      return;
    }
    watchers.forEach(watcher => watcher.close());
    watchers = next;
  }
  await attach();
  return () => { closed = true; generation++; watchers.forEach(watcher => watcher.close()); watchers = []; };
}

/** Reuse the remote file service's existing per-consumer subscriptions. Stopping
 * one task must never stop the file tree or another control device's watcher. */
export async function watchRemoteCapabilityPaths(
  manager: RemoteFileBrowserManager, hostId: string, consumerId: string,
  roots: readonly string[], changed: () => void | Promise<void>, isCurrent: () => boolean,
): Promise<() => void> {
  let closed = false;
  const directories = [...new Set(roots)];
  // Missing roots and single config files cannot be watched recursively without
  // observing the whole remote home. Compare their snapshots on a bounded timer.
  let checking: Promise<void> | undefined;
  const compare = () => {
    if (closed || !isCurrent() || checking) return;
    checking = Promise.resolve().then(changed).catch(() => undefined).finally(() => { checking = undefined; });
  };
  const timer = setInterval(compare, 30_000);
  timer.unref?.();
  const start = async (workdir: string) => {
    if (closed || !isCurrent()) return;
    try {
      await manager.request(hostId, 'watchStart', {
        workdir, consumerId, hideMetaFiles: false, showIgnoredDirs: true,
      });
      if (closed || !isCurrent()) await manager.request(hostId, 'watchStop', { workdir, consumerId });
    } catch { /* Snapshot comparison before send is the fallback for missing roots/offline hosts. */ }
  };
  const off = manager.onHostEvent(hostId, event => {
    if (!closed && isCurrent() && event.event === 'fileTree'
      && directories.includes((event.data as { workdir: string }).workdir)) compare();
  });
  const offReconnect = manager.onHostConnected(hostId, () => {
    if (closed || !isCurrent()) return;
    compare();
    for (const root of directories) void start(root);
  });
  for (const root of directories) await start(root);
  return () => {
    closed = true;
    clearInterval(timer);
    off();
    offReconnect();
    for (const workdir of directories) {
      void manager.request(hostId, 'watchStop', { workdir, consumerId }).catch(() => undefined);
    }
  };
}
