import { describe, expect, it } from 'vitest';
import { ensureMacPackageManagerPath } from '../agentToolPath';

describe('macOS package manager PATH fallback', () => {
  it('restores installed Homebrew bins after a GUI shell PATH recovery failure', () => {
    const env = { PATH: '/usr/bin:/bin' };
    ensureMacPackageManagerPath(env, 'darwin', () => true);
    expect(env.PATH).toBe('/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin');
  });

  it('keeps custom pnpm/node precedence and is idempotent', () => {
    const env = { PATH: '/custom/node/bin:/opt/homebrew/bin:/usr/bin' };
    ensureMacPackageManagerPath(env, 'darwin', () => true);
    ensureMacPackageManagerPath(env, 'darwin', () => true);
    expect(env.PATH).toBe('/custom/node/bin:/opt/homebrew/bin:/usr/bin:/usr/local/bin');
  });

  it('does not add absent directories or change other platforms', () => {
    const env = { PATH: '/usr/bin' };
    ensureMacPackageManagerPath(env, 'darwin', () => false);
    ensureMacPackageManagerPath(env, 'linux', () => true);
    expect(env.PATH).toBe('/usr/bin');
  });
});
