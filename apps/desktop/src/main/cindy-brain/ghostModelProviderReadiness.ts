import type { GhostManifest } from '../../shared/ghost.js';

/** Runtime probes owned by the subsystems that execute each plugin capability. */
export interface GhostModelProviderReadinessProbes {
  imageGenerate(): boolean;
  imageEdit(): boolean;
  videoGenerate(): boolean;
  videoEdit(): boolean;
  textOneshot(): boolean;
  embedText(): boolean;
  webSearch(): boolean;
}

/** Whether the manifest declares a Cindy capability that needs a model provider. */
export function ghostRequiresModelProvider(manifest: GhostManifest): boolean {
  const capabilities = manifest.cindy;
  return Boolean(
    capabilities?.image?.some((action) => action === 'generate' || action === 'edit') ||
    capabilities?.video?.some((action) => action === 'generate' || action === 'edit') ||
    capabilities?.text?.includes('oneshot') ||
    capabilities?.embed?.includes('text') ||
    capabilities?.search?.includes('web'),
  );
}

/**
 * A plugin is ready as soon as one of its declared model-backed capabilities has
 * an executable route. The setup gate is capability-wide, so requiring every
 * media category would block image generation when only video is unavailable
 * (or the reverse); the selected Core media route performs the final per-request
 * model and credential check.
 */
export function isGhostModelProviderReady(
  manifest: GhostManifest,
  probes: GhostModelProviderReadinessProbes,
): boolean {
  const capabilities = manifest.cindy;
  if (!capabilities) return false;

  return Boolean(
    (capabilities.image?.includes('generate') && probes.imageGenerate()) ||
    (capabilities.image?.includes('edit') && probes.imageEdit()) ||
    (capabilities.video?.includes('generate') && probes.videoGenerate()) ||
    (capabilities.video?.includes('edit') && probes.videoEdit()) ||
    (capabilities.text?.includes('oneshot') && probes.textOneshot()) ||
    (capabilities.embed?.includes('text') && probes.embedText()) ||
    (capabilities.search?.includes('web') && probes.webSearch()),
  );
}
