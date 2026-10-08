/** Offline retirement catalog. Metadata only: never grants or implements a capability. */
export interface FeatureRetirement {
  id: string;
  copyKey: string;
  source: {
    pluginIds: readonly string[];
    legacyFields?: readonly string[];
    legacySlots?: readonly string[];
    sidebarKinds?: readonly string[];
    builtinToolsetIds?: readonly string[];
  };
  replacement?: { ghostId: string; marketId: string; name: string };
}

export interface InstalledFeatureRetirement {
  id: string;
  /** Installed and enabled when first observed, before runtime projection disables it. */
  eligible: boolean;
  unread: boolean;
}

/** Keep entries across releases so users who skip versions still receive the notice. */
export const FEATURE_RETIREMENTS: readonly FeatureRetirement[] = [
  {
    id: 'embedded-ios-simulator',
    copyKey: 'settings.ghosts.retirement.embeddedSimulator',
    source: {
      pluginIds: ['ios-simulator'],
      legacyFields: ['iosSimulator'],
      legacySlots: ['ios-simulator'],
      sidebarKinds: ['ios-simulator'],
      builtinToolsetIds: ['ios-simulator'],
    },
    replacement: {
      ghostId: 'baguette-simulator',
      marketId: 'cb93909aaa6ac600bbc2f6b8a',
      name: 'Baguette',
    },
  },
];

/** Retired built-ins must not reappear through saved companion selections. */
export function isRetiredBuiltinToolset(id: string): boolean {
  return FEATURE_RETIREMENTS.some(({ source }) => source.builtinToolsetIds?.includes(id));
}

export function findFeatureRetirement(manifest: {
  id: string;
  [key: string]: unknown;
}): FeatureRetirement | undefined {
  const slots = Array.isArray(manifest.slots) ? manifest.slots : [];
  return FEATURE_RETIREMENTS.find(
    ({ source }) =>
      source.pluginIds.includes(manifest.id) ||
      source.legacyFields?.some((field) => manifest[field] === true) ||
      source.legacySlots?.some((slot) => slots.includes(slot)),
  );
}

export function featureRetirementById(id: string): FeatureRetirement | undefined {
  return FEATURE_RETIREMENTS.find((entry) => entry.id === id);
}
