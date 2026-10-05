import { createHash } from 'node:crypto';
import {
  connectedProvidersForAgent,
  isModelSelectableForNewRoute,
  type ProviderView,
} from '@cindy/model-providers';
import { GHOST_ERRAND_PERMISSION_MODES } from '../../shared/ghost.js';
import { PLUGIN_TASK_EFFORTS, type PluginTaskConfig } from './pluginTaskPrefsStore.js';
import type { PluginTaskPreferences } from '@cindy/device-link';

/** Host-owned task overrides. Never called from a plugin page's generic fetch/relay. */
export class MobileTaskSettings {
  constructor(
    private readonly deps: {
      read(id: string): PluginTaskConfig;
      write(id: string, value: PluginTaskConfig): PluginTaskConfig;
      validate(config: PluginTaskConfig): Promise<void>;
      providers(): Promise<ProviderView[]>;
      agents(): Promise<readonly string[]>;
    },
  ) {}
  read(id: string, installRevision: string): PluginTaskPreferences {
    const { workingDir: _privatePath, ...config } = this.deps.read(id);
    return {
      revision: this.revision(id, installRevision),
      config,
      permissionModes: [...GHOST_ERRAND_PERMISSION_MODES],
      defaultPermissionMode: 'ask',
    };
  }
  private revision(id: string, installation: string) {
    return createHash('sha256')
      .update(JSON.stringify([installation, this.deps.read(id)]))
      .digest('hex');
  }
  async update(
    id: string,
    installation: string,
    input: Record<string, unknown>,
    assertCurrent: () => void,
  ) {
    assertCurrent();
    const checkRevision = () => {
      assertCurrent();
      if (input.expectedRevision !== this.revision(id, installation))
        throw new Error('PLUGIN_SETTINGS_CHANGED');
    };
    checkRevision();
    // A narrow patch preserves the desktop-selected directory and other independent settings.
    const current = this.deps.read(id),
      next = { ...current };
    if (input.model === null) {
      for (const key of ['agentKind', 'providerId', 'model', 'effort', 'fastMode'] as const)
        delete next[key];
    } else if (input.model !== undefined) {
      if (!input.model || typeof input.model !== 'object' || Array.isArray(input.model))
        throw new Error('PLUGIN_SETTINGS_INVALID');
      const v = input.model as Record<string, unknown>;
      if (
        Object.keys(v).some(
          (k) => !['agentKind', 'providerId', 'model', 'effort', 'fastMode'].includes(k),
        ) ||
        !['cc', 'codex', 'pi'].includes(v.agentKind as string) ||
        typeof v.providerId !== 'string' ||
        typeof v.model !== 'string' ||
        !v.model ||
        v.model.length > 128 ||
        !v.providerId ||
        v.providerId.length > 128 ||
        (v.effort !== undefined &&
          !(PLUGIN_TASK_EFFORTS as readonly unknown[]).includes(v.effort)) ||
        typeof v.fastMode !== 'boolean'
      )
        throw new Error('PLUGIN_SETTINGS_INVALID');
      const agent = v.agentKind === 'cc' ? 'claude-code' : (v.agentKind as 'codex' | 'pi');
      if (!(await this.deps.agents()).includes(agent)) throw new Error('PLUGIN_MODEL_UNAVAILABLE');
      const views = await this.deps.providers();
      checkRevision();
      const provider = connectedProvidersForAgent(views, agent).find((p) => p.id === v.providerId);
      const model = provider?.models[agent]?.find((m) => m.id === v.model);
      if (
        !provider ||
        !model ||
        !isModelSelectableForNewRoute(model, { userProvider: provider.source === 'user' }) ||
        (v.effort !== undefined && !model.efforts.includes(v.effort as never)) ||
        (v.fastMode && model.supportsFastMode !== true)
      )
        throw new Error('PLUGIN_MODEL_UNAVAILABLE');
      next.agentKind = v.agentKind as PluginTaskConfig['agentKind'];
      next.providerId = provider.id;
      next.model = model.id;
      // The store owns its supported effort vocabulary. Empty effort means no explicit override.
      if (v.effort === undefined) delete next.effort;
      else next.effort = v.effort as PluginTaskConfig['effort'];
      next.fastMode = v.fastMode;
    }
    if (input.permissionMode === null) delete next.permissionMode;
    else if (input.permissionMode !== undefined) {
      if (!(GHOST_ERRAND_PERMISSION_MODES as readonly unknown[]).includes(input.permissionMode))
        throw new Error('PLUGIN_SETTINGS_INVALID');
      next.permissionMode = input.permissionMode as PluginTaskConfig['permissionMode'];
    }
    checkRevision();
    await this.deps.validate(next);
    checkRevision();
    this.deps.write(id, next);
    return this.read(id, installation);
  }
}
