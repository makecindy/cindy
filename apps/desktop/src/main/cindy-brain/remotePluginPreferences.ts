import { createHash } from 'node:crypto';
import type { InstalledGhost } from '../../shared/ghost.js';
import { ghostInstallApprovalToken } from '../../shared/ghost.js';
import {
  pluginHasModelPreferences,
  type RemotePluginPreferenceSnapshot,
} from '../../shared/pluginPreferences.js';
import type { MobileTaskSettings } from './mobileTaskSettings.js';

interface Dependencies {
  auxiliaryModelLabel(): string | null;
  tasks: Pick<MobileTaskSettings, 'read' | 'update'>;
  sidebar: {
    read(id: string): boolean;
    write(id: string, visible: boolean, assertCurrent: () => void): Promise<void>;
  };
}

/** Reuses the target Host's preference stores and compares revisions before a write. */
export class RemotePluginPreferences {
  constructor(private readonly deps: Dependencies) {}

  read(id: string, ghost: InstalledGhost): RemotePluginPreferenceSnapshot {
    const data: Omit<RemotePluginPreferenceSnapshot, 'revision'> = {};
    const installation = ghostInstallApprovalToken(ghost.approval);
    if (pluginHasModelPreferences(ghost.manifest)) {
      data.tasks = this.deps.tasks.read(id, installation);
      data.auxiliaryModelLabel = this.deps.auxiliaryModelLabel();
    }
    if (ghost.manifest.mainView?.html) data.sidebarVisible = this.deps.sidebar.read(id);
    return {
      ...data,
      revision: createHash('sha256')
        .update(JSON.stringify([installation, data]))
        .digest('hex'),
    };
  }

  async update(
    id: string,
    ghost: InstalledGhost,
    input: Record<string, unknown>,
    assertCurrent: () => void,
  ): Promise<RemotePluginPreferenceSnapshot> {
    const check = () => {
      assertCurrent();
      if (input.expectedRevision !== this.read(id, ghost).revision)
        throw new Error('PLUGIN_SETTINGS_CHANGED');
    };
    check();
    switch (input.kind) {
      case 'tasks': {
        const tasks = this.read(id, ghost).tasks;
        if (
          !tasks ||
          !input.patch ||
          typeof input.patch !== 'object' ||
          Array.isArray(input.patch) ||
          Object.keys(input.patch).some((key) => !['model', 'permissionMode'].includes(key))
        )
          throw new Error('PLUGIN_SETTINGS_INVALID');
        await this.deps.tasks.update(
          id,
          ghostInstallApprovalToken(ghost.approval),
          {
            ...input.patch,
            expectedRevision: tasks.revision,
          },
          check,
        );
        break;
      }
      case 'sidebar':
        if (!ghost.manifest.mainView?.html || typeof input.visible !== 'boolean')
          throw new Error('PLUGIN_SETTINGS_INVALID');
        await this.deps.sidebar.write(id, input.visible, check);
        break;
      default:
        throw new Error('PLUGIN_SETTINGS_INVALID');
    }
    assertCurrent();
    return this.read(id, ghost);
  }
}
