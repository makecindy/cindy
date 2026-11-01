import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const { valid } = createRequire(import.meta.url)('semver');

/** Terminal distributions have one immutable account region, like Desktop. */
export function readCindyBuildRegion(value = process.env.CINDY_AUTH_REGION) {
  if (value === undefined || value === '') return 'global';
  if (value === 'global' || value === 'cn') return value;
  throw new Error('CINDY_BUILD_REGION_INVALID: use global or cn');
}

/** Release builds use the same APP_VERSION as Desktop. Source runs use the
 * nearest release in their own ancestry, never an unrelated newer tag. */
export function readCindyBuildVersion() {
  let version = process.env.APP_VERSION;
  if (!version) {
    try {
      version = execFileSync(
        'git', ['describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*', 'HEAD'],
        { cwd: fileURLToPath(new URL('../../..', import.meta.url)), encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'pipe'] },
      ).trim().replace(/^v/, '');
    } catch {
      // Pull request checkouts intentionally omit tags. Release packaging always
      // supplies APP_VERSION; source tests only need a valid development identity.
      // Device Link uses 0.0.0 for development builds and then negotiates
      // capabilities. A prerelease suffix would make this host look too old.
      version = '0.0.0';
    }
  }
  if (valid(version) !== version) throw new Error('CINDY_BUILD_VERSION_INVALID: set APP_VERSION to the Cindy release version');
  return version;
}
