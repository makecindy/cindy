import path from 'node:path';
import { matchDeepLinkPrefix } from '../../shared/deepLinkSchemes.js';

/** Only existing product entry arguments may cross a version handoff; no Node/debug/profile flags. */
export function versionEntryArguments(argv: readonly string[]): string[] {
  const result: string[] = [];
  for (let i = 0; i < argv.length && result.length < 16; i++) {
    const value = argv[i];
    if (value.length > 16_384) continue;
    if (matchDeepLinkPrefix(value)) result.push(value);
    else if (
      ['--open-folder', '--open-share-file'].includes(value) &&
      path.isAbsolute(argv[i + 1] ?? '')
    )
      result.push(value, argv[++i]);
    else if (
      /^--open-(?:folder|share-file)=/.test(value) &&
      path.isAbsolute(value.slice(value.indexOf('=') + 1))
    )
      result.push(value);
    else if (path.isAbsolute(value) && /\.(cindy|cshare)$/i.test(value)) result.push(value);
  }
  return result;
}
