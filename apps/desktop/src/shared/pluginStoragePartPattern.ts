/**
 * Flat instance storage key.
 * ghost.ts and pluginIdentity.ts both accept this shape. Neither file can
 * import the other, so the pattern lives here.
 * Root: helper. New root: _root__helper. Organization: _ns__<namespace>__<id>.
 */
export const PLUGIN_STORAGE_PART_RE =
  /^(?:[a-z0-9][a-z0-9-]{0,31}|_root__[a-z0-9][a-z0-9-]{0,31}|_ns__[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?__[a-z0-9][a-z0-9-]{0,31})$/;
