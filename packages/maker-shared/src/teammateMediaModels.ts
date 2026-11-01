/** Provider identities belong to the computer executing the media operation. No credentials. */
export interface MediaModelRef {
  providerId: string;
  modelId: string;
}

export interface TeammateMediaModels {
  /** Missing/null follows the app. A complete override can explicitly disable fallback. */
  vision?: { primary: MediaModelRef; fallback: MediaModelRef | null } | null;
  image?: MediaModelRef | null;
  video?: MediaModelRef | null;
}

export type TeammateMediaCatalog = Record<'vision' | 'image' | 'video', Array<MediaModelRef & { label: string }>> & { unavailable?: Array<'vision' | 'image' | 'video'> };

const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid media model selection');
  return value as Record<string, unknown>;
};

function ref(value: unknown): MediaModelRef {
  const item = record(value);
  if (Object.keys(item).some(key => key !== 'providerId' && key !== 'modelId') ||
      typeof item.providerId !== 'string' || !item.providerId.trim() || item.providerId.length > 512 ||
      typeof item.modelId !== 'string' || !item.modelId.trim() || item.modelId.length > 2048) {
    throw new Error('Invalid provider/model reference');
  }
  return { providerId: item.providerId.trim(), modelId: item.modelId.trim() };
}

/** Strict on writes; null/empty removes the whole override, never freezes app defaults. */
export function parseTeammateMediaModels(value: unknown): TeammateMediaModels | null {
  if (value === null || value === undefined) return null;
  const input = record(value);
  if (Object.keys(input).some(key => !['vision', 'image', 'video'].includes(key))) throw new Error('Unknown media model setting');
  const output: TeammateMediaModels = {};
  if (input.vision !== undefined && input.vision !== null) {
    const vision = record(input.vision);
    if (Object.keys(vision).some(key => key !== 'primary' && key !== 'fallback') || vision.fallback === undefined) {
      throw new Error('Vision override requires primary and fallback');
    }
    output.vision = { primary: ref(vision.primary), fallback: vision.fallback === null ? null : ref(vision.fallback) };
  }
  for (const kind of ['image', 'video'] as const) {
    if (input[kind] !== undefined && input[kind] !== null) output[kind] = ref(input[kind]);
  }
  return Object.keys(output).length ? output : null;
}

export function effectiveTeammateVision<T extends { primary: MediaModelRef | null; fallback: MediaModelRef | null }>(
  app: T, overrides?: TeammateMediaModels | null,
): T {
  return overrides?.vision ? { ...app, ...overrides.vision } : app;
}
