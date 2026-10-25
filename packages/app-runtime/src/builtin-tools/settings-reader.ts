/**
 * Settings reader — reads user-default and project-level plugin preferences from disk,
 * with simple mtime+size-based in-memory caching.
 *
 * Project settings: <workingDir>/.claude/settings.json → xdtMaker.builtinTools.{id}
 * User defaults: <userData>/builtin-tools-settings.json → builtinTools.{id}
 *
 * Sync path (readProjectPluginSetting) is used by the MCP provider isEnabled
 * gate during session start. Async path is used by IPC handlers.
 *
 * All read errors (missing file, bad JSON, wrong shape) are logged as warnings
 * and treated as "no override" — the caller falls through to the next priority tier.
 */

import * as fs from 'node:fs';
import path from 'node:path';
import type { PluginId, XdtMakerSettings } from './types.js';

export interface SettingsReaderDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  logger: { warn: (...args: any[]) => void };
  userDataPath?: string;
}

interface ProjectCacheEntry {
  settings: Map<PluginId, boolean>;
  mtimeMs: number;
  size: number;
}

export class SettingsReader {
  private log: SettingsReaderDeps['logger'];
  private userDataPath?: string;

  /** project-settings cache keyed by workingDir. Invalidated on mtime OR size change. */
  private projectCache = new Map<string, ProjectCacheEntry>();
  private globalCache: ProjectCacheEntry | null = null;

  constructor(deps: SettingsReaderDeps) {
    this.log = deps.logger;
    this.userDataPath = deps.userDataPath;
  }

  // ── Global settings ───────────────────────────────────────────────────────

  readGlobalPluginSetting(pluginId: PluginId): boolean | null {
    const entry = this.loadGlobalSettingsSync();
    if (!entry) return null;
    const val = entry.settings.get(pluginId);
    return val !== undefined ? val : null;
  }

  async writeGlobalPluginSetting(pluginId: PluginId, enabled: boolean): Promise<void> {
    const settingsPath = this.getGlobalSettingsPath();
    const root = await this.readJsonFile(settingsPath);
    const builtinTools = (root.builtinTools as Record<string, { enabled?: boolean }> | undefined) ?? {};
    builtinTools[pluginId] = { ...builtinTools[pluginId], enabled };
    root.builtinTools = builtinTools;
    await fs.promises.mkdir(path.dirname(settingsPath), { recursive: true });
    await fs.promises.writeFile(settingsPath, JSON.stringify(root, null, 2), 'utf-8');
    this.globalCache = null;
  }

  async clearGlobalPluginSetting(pluginId: PluginId): Promise<void> {
    const settingsPath = this.getGlobalSettingsPath();
    const root = await this.readJsonFile(settingsPath);
    const builtinTools = (root.builtinTools as Record<string, unknown> | undefined) ?? {};
    if (!(pluginId in builtinTools)) return;
    delete builtinTools[pluginId];
    root.builtinTools = builtinTools;
    await fs.promises.mkdir(path.dirname(settingsPath), { recursive: true });
    await fs.promises.writeFile(settingsPath, JSON.stringify(root, null, 2), 'utf-8');
    this.globalCache = null;
  }

  // ── Project settings ──────────────────────────────────────────────────────

  /**
   * Synchronous read of a single project-level plugin override.
   * Uses mtime-based caching; first read for a workingDir does sync file IO.
   */
  readProjectPluginSetting(workingDir: string, pluginId: PluginId): boolean | null {
    const entry = this.loadProjectSettingsSync(workingDir);
    if (!entry) return null;
    const val = entry.settings.get(pluginId);
    return val !== undefined ? val : null;
  }

  /** Sync read of ALL project plugin overrides for a working dir. */
  readAllProjectOverrides(workingDir: string): Map<PluginId, boolean> {
    const entry = this.loadProjectSettingsSync(workingDir);
    return entry ? new Map(entry.settings) : new Map();
  }

  /** Same as readProjectPluginSetting but async (for IPC handlers). */
  async readProjectPluginSettingAsync(workingDir: string, pluginId: PluginId): Promise<boolean | null> {
    return this.readProjectPluginSetting(workingDir, pluginId);
  }

  /** Write a project-level plugin override to .claude/settings.json. */
  async writeProjectPluginSetting(workingDir: string, pluginId: PluginId, enabled: boolean): Promise<void> {
    const settingsPath = path.join(workingDir, '.claude', 'settings.json');

    // Read existing file, preserving all other keys
    const root = await this.readJsonFile(settingsPath);

    const xdtMaker = (root.xdtMaker as Record<string, unknown> | undefined) ?? {};
    const builtinTools = (xdtMaker.builtinTools as Record<string, { enabled?: boolean }> | undefined) ?? {};
    builtinTools[pluginId] = { ...builtinTools[pluginId], enabled };

    root.xdtMaker = { ...xdtMaker, builtinTools };
    await fs.promises.mkdir(path.dirname(settingsPath), { recursive: true });
    await fs.promises.writeFile(settingsPath, JSON.stringify(root, null, 2), 'utf-8');

    // Invalidate cache for this workingDir
    this.projectCache.delete(workingDir);
  }

  /** Remove a project-level override so the plugin follows the user/product default again. */
  async clearProjectPluginSetting(workingDir: string, pluginId: PluginId): Promise<void> {
    const settingsPath = path.join(workingDir, '.claude', 'settings.json');

    let root: Record<string, unknown> = {};
    try {
      const raw = await fs.promises.readFile(settingsPath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        root = parsed as Record<string, unknown>;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }

    const xdtMaker = (root.xdtMaker as Record<string, unknown> | undefined) ?? {};
    const builtinTools = (xdtMaker.builtinTools as Record<string, unknown> | undefined) ?? {};
    const legacyPlugins = (xdtMaker.plugins as Record<string, unknown> | undefined) ?? {};
    const hadBuiltinOverride = pluginId in builtinTools;
    const hadLegacyOverride = pluginId in legacyPlugins;
    if (!hadBuiltinOverride && !hadLegacyOverride) return;

    if (hadBuiltinOverride) delete builtinTools[pluginId];
    if (hadLegacyOverride) delete legacyPlugins[pluginId];
    root.xdtMaker = {
      ...xdtMaker,
      ...(xdtMaker.builtinTools ? { builtinTools } : {}),
      ...(xdtMaker.plugins ? { plugins: legacyPlugins } : {}),
    };
    await fs.promises.writeFile(settingsPath, JSON.stringify(root, null, 2), 'utf-8');
    this.projectCache.delete(workingDir);
  }

  private getGlobalSettingsPath(): string {
    const base = this.userDataPath ?? process.cwd();
    return path.join(base, 'builtin-tools-settings.json');
  }

  private async readJsonFile(filePath: string): Promise<Record<string, unknown>> {
    try {
      const raw = await fs.promises.readFile(filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return {};
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw err;
    }
  }

  private loadGlobalSettingsSync(): ProjectCacheEntry | null {
    return this.loadSettingsFileSync(this.getGlobalSettingsPath(), 'global');
  }

  private loadProjectSettingsSync(workingDir: string): ProjectCacheEntry | null {
    const settingsPath = path.join(workingDir, '.claude', 'settings.json');
    return this.loadSettingsFileSync(settingsPath, workingDir);
  }

  private loadSettingsFileSync(settingsPath: string, cacheKey: string): ProjectCacheEntry | null {
    let mtimeMs = 0;
    let size = 0;
    try {
      const stat = fs.statSync(settingsPath);
      mtimeMs = stat.mtimeMs;
      size = stat.size;
    } catch {
      if (cacheKey === 'global') this.globalCache = null;
      else this.projectCache.delete(cacheKey);
      return null;
    }

    // mtime alone is not enough: two writes within the same filesystem mtime tick
    // (sub-ms edits by an external editor / agent, or coarse-resolution FS) share an
    // mtimeMs, which would otherwise return a stale cache entry. Compare size too —
    // both come from the same statSync, so this stays IO-free on the hot path.
    const cached = cacheKey === 'global' ? this.globalCache : this.projectCache.get(cacheKey);
    if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
      return cached;
    }

    try {
      const raw = fs.readFileSync(settingsPath, 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      const map = new Map<PluginId, boolean>();

      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const xdtMaker = cacheKey === 'global' ? parsed : (parsed as XdtMakerSettings).xdtMaker;
        // Prefer new key, fall back to old Phase 1 key (xdtMaker.plugins).
        const rawMaker = xdtMaker as Record<string, unknown> | undefined;
        const tools = rawMaker?.builtinTools ?? rawMaker?.plugins;
        if (tools && typeof tools === 'object') {
          for (const [id, entry] of Object.entries(tools as Record<string, unknown>)) {
            if (entry && typeof entry === 'object' && typeof (entry as Record<string, unknown>).enabled === 'boolean') {
              map.set(id, (entry as { enabled: boolean }).enabled);
            }
          }
        }
      }

      const entry: ProjectCacheEntry = { settings: map, mtimeMs, size };
      if (cacheKey === 'global') this.globalCache = entry;
      else this.projectCache.set(cacheKey, entry);
      return entry;
    } catch (err) {
      this.log.warn(`[plugin-settings] failed to parse project settings: ${settingsPath}`, {
        error: err instanceof Error ? err.message : String(err),
      });
      if (cacheKey === 'global') this.globalCache = null;
      else this.projectCache.delete(cacheKey);
      return null;
    }
  }
}
