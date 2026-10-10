/** Native CLI owns Cursor credentials. Cindy reads status without reading or copying secrets. */
import { execFile } from 'node:child_process';
import type { AuthAdapter, AuthState } from '@cindy/maker-core';

export function parseCursorAuthStatus(output: string): AuthState {
  try {
    const value = JSON.parse(output) as { isAuthenticated?: boolean; status?: string };
    return { authenticated: value.isAuthenticated === true || value.status === 'authenticated', authSource: 'oauth' };
  } catch {
    return { authenticated: /\blogged in\b/i.test(output) && !/\bnot logged in\b/i.test(output), authSource: 'oauth' };
  }
}

export function createDesktopCursorAuthAdapter(binaryPath: string, readStatus = (): Promise<string> =>
  new Promise((resolve, reject) => execFile(binaryPath, ['status'], {
    timeout: 15_000, maxBuffer: 64 * 1024, encoding: 'utf8', windowsHide: true,
  }, (error, stdout) => error ? reject(error) : resolve(stdout))),
): AuthAdapter {
  return {
    async getState() {
      try { return parseCursorAuthStatus(await readStatus()); }
      catch { return { authenticated: false, errorReason: 'cursor_cli_login_required' }; }
    },
    async triggerLogin() {
      return { authenticated: false, errorReason: 'Run agent login (or cursor-agent login) in a terminal, then refresh Cursor models.' };
    },
    async logout() { throw new Error('Run agent logout (or cursor-agent logout) in a terminal to disconnect Cursor.'); },
    async getAuthEnv() { return {}; },
    async getOneShotAuth() { return null; },
  };
}
