import type { MediaCapability } from '@cindy/model-providers';

const MEDIA_CAPABILITY_REQUIREMENTS: Record<MediaCapability, { input: string[]; output: string }> = {
  'image.generate': { input: ['text'], output: 'image' },
  'image.edit': { input: ['text', 'image'], output: 'image' },
  'video.generate': { input: ['text'], output: 'video' },
  'video.image_to_video': { input: ['text', 'image'], output: 'video' },
};

export function supportsMediaCapability(
  modalities: { input: string[]; output: string[] } | undefined,
  capability: MediaCapability,
): boolean {
  if (!modalities) return false;
  const requirement = MEDIA_CAPABILITY_REQUIREMENTS[capability];
  const inputs = new Set(modalities.input);
  return (
    modalities.output.includes(requirement.output) &&
    requirement.input.every((input) => inputs.has(input))
  );
}
