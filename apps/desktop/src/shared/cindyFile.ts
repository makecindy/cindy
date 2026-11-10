/** File-level format; legacy ghost.json plugins do not need this manifest. */
export const CINDY_PACKAGE_MANIFEST = 'cindy.json';
export const CINDY_PACKAGE_FORMAT_VERSION = 1;

export interface CindyThemePackageManifest {
  formatVersion: 1;
  type: 'theme';
  themes: string[];
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
  if (value.formatVersion !== CINDY_PACKAGE_FORMAT_VERSION || value.type !== 'theme') {
    throw new CindyFileError('unsupported');
  }
  if (!Array.isArray(value.themes) || value.themes.length === 0 || value.themes.length > 256
    || !value.themes.every(isCindyPackagePath)
    || new Set(value.themes).size !== value.themes.length) throw new CindyFileError('invalid');
  return { formatVersion: 1, type: 'theme', themes: value.themes };
}
