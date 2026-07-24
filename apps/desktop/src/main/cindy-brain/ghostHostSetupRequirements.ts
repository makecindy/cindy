/**
 * Host-owned client configuration projected into the generic Setup Runtime.
 *
 * Entries match declared host capabilities, never plugin ids or provider ids.
 * This keeps the Setup coordinator generic: adding another plugin that uses an
 * existing host capability needs no Core branch, while the owning subsystem
 * remains the authority for whether that client configuration is ready.
 */

import type {
  GhostManifest,
  GhostSetupAssessmentGroup,
} from '../../shared/ghost.js';

export interface GhostHostSetupRequirementProbes {
  clientConfigReady(configId: string): boolean;
}

interface GhostHostSetupRequirementProvider {
  configId: string;
  label: string;
  description: string;
  matches(manifest: GhostManifest): boolean;
}

const providers: readonly GhostHostSetupRequirementProvider[] = [
  {
    configId: 'model-provider',
    label: 'AI 模型服务',
    description: '使用插件声明的图片或视频能力前，需要先连接可用的模型服务',
    matches: (manifest) =>
      Object.values(manifest.cindy ?? {}).some((actions) => (actions?.length ?? 0) > 0),
  },
];

export function assessGhostHostSetupRequirements(
  manifest: GhostManifest,
  probes: GhostHostSetupRequirementProbes,
): GhostSetupAssessmentGroup[] {
  return providers
    .filter((provider) => provider.matches(manifest))
    .map((provider) => {
      const satisfied = probes.clientConfigReady(provider.configId);
      const ref = `client_config:${provider.configId}`;
      return {
        id: `host:${ref}`,
        mode: 'any_of' as const,
        items: [
          {
            ref,
            kind: 'client_config' as const,
            label: provider.label,
            description: provider.description,
            state: satisfied ? ('satisfied' as const) : ('missing' as const),
            actions: satisfied
              ? []
              : [
                  {
                    id: `open_client_settings:${ref}`,
                    kind: 'open_client_settings' as const,
                  },
                ],
          },
        ],
      };
    });
}
