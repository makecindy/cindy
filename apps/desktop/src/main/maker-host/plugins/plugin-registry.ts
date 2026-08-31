/**
 * PluginRegistry — scoped enable decision with essential override.
 *
 * Priority (highest to lowest):
 *   1. essential === true          → always enabled
 *   2. machine-wide setting        → existing global semantics for OS tools
 *   3. project settings explicit   → use project value
 *   4. user default                → default for newly created conversations
 *   5. builtin default             → true, except explicitly opt-in plugins
 *
 * isEnabled() is synchronous (used by MCP provider gate during session start).
 * getEnableState() is async (used by IPC handlers for the Settings UI).
 *
 * Essential plugins are hidden from listPlugins() — they are infrastructure
 * that cannot be toggled, so showing them adds no value.
 */

import type { Plugin, PluginId } from './types.js';
import { DEFAULT_DISABLED_PLUGIN_IDS, ESSENTIAL_PLUGIN_IDS, GLOBAL_PLUGIN_IDS, HOSTED_ELSEWHERE_PLUGIN_IDS } from './types.js';
import type { SettingsReader } from './settings-reader.js';
import { createBuiltinPlugins } from './builtin-plugins.js';

export interface PluginRegistryDeps {
  settingsReader: SettingsReader;
}

export interface PluginEnableState {
  effectiveEnabled: boolean;
  productDefaultEnabled: boolean;
  projectOverride?: { enabled: boolean; workingDir: string } | null;
  userOverride?: { enabled: boolean } | null;
  globalOverride?: { enabled: boolean } | null;
  /** collab 查询对 workspaceKind 的显式确认；旧被控端缺省，控制端据此关闭 dialogue 入口。 */
  collabWorkspaceKind?: 'project' | 'dialogue';
}

export interface PluginListItem {
  id: string;
  name: string;
  description: string;
  source: 'builtin' | 'hub' | 'local';
  essential: boolean;
  effectiveEnabled: boolean;
  productDefaultEnabled: boolean;
  projectOverride?: { enabled: boolean; workingDir: string } | null;
  userOverride?: { enabled: boolean } | null;
  globalOverride?: { enabled: boolean } | null;
}

export class PluginRegistry {
  private plugins: Plugin[];
  private settingsReader: SettingsReader;

  constructor(deps: PluginRegistryDeps) {
    this.settingsReader = deps.settingsReader;
    this.plugins = createBuiltinPlugins();
  }

  /**
   * Synchronous scoped enable check.
   * Called from MCP provider isEnabled(ctx) gate during session start.
   */
  isEnabled(pluginId: PluginId, workingDir?: string): boolean {
    // Tier 0 — unknown plugin: fail-open.
    const plugin = this.plugins.find((p) => p.id === pluginId);
    if (!plugin && !ESSENTIAL_PLUGIN_IDS.has(pluginId)) return true;

    // Tier 1 — essential: always enabled.
    if (ESSENTIAL_PLUGIN_IDS.has(pluginId)) {
      return true;
    }

    // Tier 2 — global settings for machine-level plugins.
    if (GLOBAL_PLUGIN_IDS.has(pluginId)) {
      const globalVal = this.settingsReader.readGlobalPluginSetting(pluginId);
      if (globalVal !== null) return globalVal;
      return !DEFAULT_DISABLED_PLUGIN_IDS.has(pluginId);
    }

    // Tier 3 — project settings.
    if (workingDir) {
      const projectVal = this.settingsReader.readProjectPluginSetting(workingDir, pluginId);
      if (projectVal !== null) return projectVal;
    }

    // Tier 4 — user default for ordinary built-in tools.
    const userVal = this.settingsReader.readGlobalPluginSetting(pluginId);
    if (userVal !== null) return userVal;

    // Tier 5 — builtin default.
    return !DEFAULT_DISABLED_PLUGIN_IDS.has(pluginId);
  }

  /** Full async enable-state query used by IPC handlers. */
  async getEnableState(pluginId: PluginId, workingDir?: string): Promise<PluginEnableState> {
    const plugin = this.plugins.find((p) => p.id === pluginId);
    const essential = plugin?.essential ?? ESSENTIAL_PLUGIN_IDS.has(pluginId);

    if (essential) {
      return {
        effectiveEnabled: true,
        productDefaultEnabled: true,
        projectOverride: null,
        userOverride: null,
        globalOverride: null,
      };
    }

    const productDefaultEnabled = !DEFAULT_DISABLED_PLUGIN_IDS.has(pluginId);

    let globalOverride: { enabled: boolean } | null = null;
    if (GLOBAL_PLUGIN_IDS.has(pluginId)) {
      const gv = this.settingsReader.readGlobalPluginSetting(pluginId);
      if (gv !== null) {
        globalOverride = { enabled: gv };
      }
      return {
        effectiveEnabled:
          globalOverride !== null ? globalOverride.enabled : productDefaultEnabled,
        productDefaultEnabled,
        projectOverride: null,
        userOverride: null,
        globalOverride,
      };
    }

    const userValue = this.settingsReader.readGlobalPluginSetting(pluginId);
    const userOverride = userValue === null ? null : { enabled: userValue };

    let projectOverride: { enabled: boolean; workingDir: string } | null = null;
    if (workingDir) {
      const pv = this.settingsReader.readProjectPluginSetting(workingDir, pluginId);
      if (pv !== null) {
        projectOverride = { enabled: pv, workingDir };
      }
    }

    const effectiveEnabled =
      projectOverride !== null
        ? projectOverride.enabled
        : userOverride !== null
          ? userOverride.enabled
          : productDefaultEnabled;

    return {
      effectiveEnabled,
      productDefaultEnabled,
      projectOverride,
      userOverride,
      globalOverride: null,
    };
  }

  /**
   * List non-essential plugins with their enable state for the Settings UI.
   * Essential plugins are hidden — they can't be toggled, so showing them
   * adds only cognitive burden.
   */
  async listPlugins(workingDir?: string): Promise<PluginListItem[]> {
    const results: PluginListItem[] = [];
    for (const plugin of this.plugins) {
      if (ESSENTIAL_PLUGIN_IDS.has(plugin.id)) continue;
      // Toggleable but surfaced in a dedicated Settings section (e.g. browser
      // under「电脑使用」), so omit from the generic project list. Browser is
      // also an ordinary per-conversation tool, however, and must remain
      // configurable when this list represents the user-default scope.
      if (
        HOSTED_ELSEWHERE_PLUGIN_IDS.has(plugin.id)
        && !(workingDir === undefined && plugin.id === 'browser')
      ) {
        continue;
      }
      const state = await this.getEnableState(plugin.id, workingDir);
      results.push({
        id: plugin.id,
        name: plugin.name,
        description: plugin.description,
        source: plugin.source,
        essential: false,
        effectiveEnabled: state.effectiveEnabled,
        productDefaultEnabled: state.productDefaultEnabled,
        projectOverride: state.projectOverride ?? undefined,
        userOverride: state.userOverride ?? undefined,
        globalOverride: state.globalOverride ?? undefined,
      });
    }
    return results;
  }

  /**
   * Set project-level override for a plugin. Essential plugins reject
   * silently (return false).
   */
  async setProjectEnabled(pluginId: PluginId, workingDir: string, enabled: boolean): Promise<boolean> {
    if (ESSENTIAL_PLUGIN_IDS.has(pluginId)) return false;
    if (GLOBAL_PLUGIN_IDS.has(pluginId)) {
      return this.setEnabled(pluginId, enabled);
    }
    const userValue = this.settingsReader.readGlobalPluginSetting(pluginId);
    const productDefaultEnabled = !DEFAULT_DISABLED_PLUGIN_IDS.has(pluginId);
    // A project selection that matches a mutable user default is still an
    // explicit override. Keep it so later user-default edits cannot silently
    // change this project. Only elide the stable product-default case.
    if (userValue === null && enabled === productDefaultEnabled) {
      await this.settingsReader.clearProjectPluginSetting(workingDir, pluginId);
      return true;
    }
    await this.settingsReader.writeProjectPluginSetting(workingDir, pluginId, enabled);
    return true;
  }

  async clearProjectEnabled(pluginId: PluginId, workingDir: string): Promise<boolean> {
    if (ESSENTIAL_PLUGIN_IDS.has(pluginId)) return false;
    if (GLOBAL_PLUGIN_IDS.has(pluginId)) {
      return this.clearEnabled(pluginId);
    }
    await this.settingsReader.clearProjectPluginSetting(workingDir, pluginId);
    return true;
  }

  async setEnabled(pluginId: PluginId, enabled: boolean): Promise<boolean> {
    if (ESSENTIAL_PLUGIN_IDS.has(pluginId)) return false;
    // A toggle is an explicit user choice even when it currently matches the
    // product default. Only clearEnabled(), exposed as "Restore default" in
    // Settings, may remove that choice.
    await this.settingsReader.writeGlobalPluginSetting(pluginId, enabled);
    return true;
  }

  async clearEnabled(pluginId: PluginId): Promise<boolean> {
    if (ESSENTIAL_PLUGIN_IDS.has(pluginId)) return false;
    await this.settingsReader.clearGlobalPluginSetting(pluginId);
    return true;
  }

  /**
   * Freeze the ordinary built-in tool policy for a newly created runtime.
   * Machine-wide plugins are intentionally excluded: their existing lifecycle
   * rebuilds the Codex environment when the setting changes.
   */
  getDisabledRuntimePluginIds(workingDir?: string): string[] {
    return this.plugins
      .filter((plugin) =>
        // Collaboration is authorized live by the Main Orca lifecycle handlers.
        // Freezing it here would keep an existing Codex thread disabled after
        // the project setting is enabled.
        plugin.id !== 'collab' &&
        // iOS Simulator access is the live plugin gate (install / enable /
        // workdir). Leftover Tools-page builtinTools['ios-simulator'] must not
        // freeze Codex/Pi MCP off after that toggle left Settings.
        plugin.id !== 'ios-simulator' &&
        !ESSENTIAL_PLUGIN_IDS.has(plugin.id) &&
        !GLOBAL_PLUGIN_IDS.has(plugin.id) &&
        !this.isEnabled(plugin.id, workingDir),
      )
      .map((plugin) => plugin.id);
  }

  /** Get all registered plugins (metadata only, no enable state). Returns a copy. */
  getPlugins(): Plugin[] {
    return this.plugins.map((p) => ({
      ...p,
      capabilities: { ...p.capabilities, mcps: [...(p.capabilities.mcps ?? [])] },
    }));
  }
}
