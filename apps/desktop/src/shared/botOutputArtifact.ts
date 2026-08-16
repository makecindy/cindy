/** Durable, transport-neutral output produced by a Bot task. */
export interface BotOutputArtifact {
  /** Stable Cindy-managed or compatibility-protocol reference. */
  ref: string;
  kind: 'image' | 'video' | 'audio' | 'model' | 'file' | 'media';
}

const OUTPUT_ARTIFACT_PATTERN =
  /\b(?:cindy-media|xdt-image|xdt-video|xdt-audio|xdt-model|xdt-file):\/\/[^\s"'<>()\[\]{}]+/g;

function artifactKind(ref: string): BotOutputArtifact['kind'] {
  if (ref.startsWith('xdt-image://')) return 'image';
  if (ref.startsWith('xdt-video://')) return 'video';
  if (ref.startsWith('xdt-audio://')) return 'audio';
  if (ref.startsWith('xdt-model://')) return 'model';
  if (ref.startsWith('xdt-file://')) return 'file';
  const extension = ref.slice(ref.lastIndexOf('.') + 1).toLowerCase();
  if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(extension)) return 'image';
  if (['mp4', 'mov', 'webm'].includes(extension)) return 'video';
  if (['mp3', 'wav', 'm4a'].includes(extension)) return 'audio';
  if (['glb', 'gltf'].includes(extension)) return 'model';
  return 'media';
}

/** Extract only protocol references already owned by Cindy's media/file boundaries. */
export function collectBotOutputArtifacts(text: string | null | undefined): BotOutputArtifact[] {
  if (!text) return [];
  const seen = new Set<string>();
  const artifacts: BotOutputArtifact[] = [];
  for (const ref of text.match(OUTPUT_ARTIFACT_PATTERN) ?? []) {
    if (seen.has(ref)) continue;
    seen.add(ref);
    artifacts.push({ ref, kind: artifactKind(ref) });
  }
  return artifacts;
}

export function parseBotOutputArtifacts(value: string | null | undefined): BotOutputArtifact[] {
  try {
    const parsed = JSON.parse(value ?? '[]') as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
      const ref = (item as { ref?: unknown }).ref;
      const kind = (item as { kind?: unknown }).kind;
      if (
        typeof ref !== 'string'
        || !['image', 'video', 'audio', 'model', 'file', 'media'].includes(String(kind))
      ) return [];
      return [{ ref, kind: kind as BotOutputArtifact['kind'] }];
    });
  } catch {
    return [];
  }
}
