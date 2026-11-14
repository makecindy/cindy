export type MediaGuideSource = 'auto' | 'official';

/** Discovery has no loaded state. A prepared invocation owns its own snapshot. */
export async function resolveMediaGuide<T>(source: MediaGuideSource, ports: {
  readCustom(): T | null;
  readOfficial(): Promise<T | null>;
}): Promise<{ source: 'custom' | 'official'; value: T } | null> {
  if (source === 'auto') {
    const custom = ports.readCustom();
    if (custom) return { source: 'custom', value: custom };
  }
  const official = await ports.readOfficial();
  return official ? { source: 'official', value: official } : null;
}
