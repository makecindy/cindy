import type { AppearanceResourceDefinition } from './appearanceDefinition';

/** File-level format; legacy ghost.json plugins do not need this manifest. */
export const CINDY_PACKAGE_MANIFEST = 'cindy.json';
export const CINDY_PACKAGE_FORMAT_VERSION = 2;

export interface CindyThemePackageManifest {
  formatVersion: 1 | 2;
  type: 'theme';
  themes: string[];
  resources?: AppearanceResourceDefinition[];
}

export type CindyFileOpenResult =
  | { type: 'plugin' }
  | { type: 'theme'; names: string[] }
  | { type: 'unsupported' | 'invalid' | 'failed' };

export class CindyFileError extends Error {
  constructor(public readonly code: 'unsupported' | 'invalid') {
    super(code);
  }
}

/** Portable package paths, never a host path, URL, drive or Windows ADS. */
export function isCindyPackagePath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096
    && !/[\\:<>"|?*\x00-\x1f]/.test(value)
    && value.split('/').every(part => part !== '' && part !== '.' && part !== '..'
      && !/[. ]$/.test(part) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}

export function parseCindyPackageManifest(raw: unknown): CindyThemePackageManifest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new CindyFileError('invalid');
  const value = raw as Record<string, unknown>;
  if (!Number.isSafeInteger(value.formatVersion) || (value.formatVersion as number) < 1
    || typeof value.type !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(value.type)) {
    throw new CindyFileError('invalid');
  }
  // Check the common header before inspecting any type-specific payload.
  // Future types and versions must never fall through to the plugin parser.
  if ((value.formatVersion as number) > CINDY_PACKAGE_FORMAT_VERSION || value.type !== 'theme') {
    throw new CindyFileError('unsupported');
  }
  if (!Array.isArray(value.themes) || value.themes.length === 0 || value.themes.length > 256
    || !value.themes.every(isCindyPackagePath)
    || new Set(value.themes).size !== value.themes.length) throw new CindyFileError('invalid');
  let resources: AppearanceResourceDefinition[] | undefined;
  if (value.resources !== undefined) {
    if (value.formatVersion !== 2 || !Array.isArray(value.resources) || value.resources.length > 256) throw new CindyFileError('invalid');
    const ids = new Set<string>();
    resources = value.resources.map((raw): AppearanceResourceDefinition => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new CindyFileError('invalid');
      const r = raw as Record<string, unknown>;
      if (Object.keys(r).some(key => !['id', 'kind', 'path'].includes(key)) || typeof r.id !== 'string' ||
          !/^[a-zA-Z0-9_-]{1,64}$/.test(r.id) || ids.has(r.id) || !['font', 'image', 'video'].includes(String(r.kind)) ||
          !isCindyPackagePath(r.path)) throw new CindyFileError('invalid');
      ids.add(r.id);
      return { id: r.id, kind: r.kind as AppearanceResourceDefinition['kind'], path: r.path };
    });
  }
  return { formatVersion: value.formatVersion as 1 | 2, type: 'theme', themes: value.themes, ...(resources ? { resources } : {}) };
}
