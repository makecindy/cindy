import { describe, expect, it } from 'vitest';

import { workbenchSessionRoots } from '../botWorkbenchSessionRoots.js';

const SUPPORT = '/Users/me/Library/Application Support';

describe('workbenchSessionRoots', () => {
  it('lists native Claude Code, Codex and Pi transcript dirs including every Cindy profile on macOS', () => {
    const roots = workbenchSessionRoots({
      homeDir: '/Users/me',
      appDataDir: SUPPORT,
      userDataDir: `${SUPPORT}/CindyGlobal-dev2-bot-workbench`,
      platform: 'darwin',
      env: {},
    });
    expect(roots.claude).toEqual(['/Users/me/.claude/projects']);
    for (const home of [
      '/Users/me/.codex',
      `${SUPPORT}/Codex/codex-home`,
      `${SUPPORT}/Codex`,
      `${SUPPORT}/CindyGlobal-dev2-bot-workbench/codex-home`,
      `${SUPPORT}/Cindy/codex-home`,
      `${SUPPORT}/CindyGlobal/codex-home`,
      `${SUPPORT}/CindyDev/codex-home`,
      `${SUPPORT}/xdt-maker/codex-home`,
    ]) {
      expect(roots.codex).toContain(`${home}/sessions`);
      expect(roots.codex).toContain(`${home}/archived_sessions`);
    }
    expect(roots.pi).toEqual([
      `${SUPPORT}/CindyGlobal-dev2-bot-workbench/pi-agent-home/sessions`,
      `${SUPPORT}/Cindy/pi-agent-home/sessions`,
      `${SUPPORT}/CindyGlobal/pi-agent-home/sessions`,
      `${SUPPORT}/CindyDev/pi-agent-home/sessions`,
      `${SUPPORT}/xdt-maker/pi-agent-home/sessions`,
    ]);
  });

  it('honours CODEX_HOME / CLAUDE_CONFIG_DIR and does not repeat the current profile', () => {
    const roots = workbenchSessionRoots({
      homeDir: '/home/me',
      appDataDir: '/home/me/.config',
      userDataDir: '/home/me/.config/Cindy',
      platform: 'linux',
      env: { CODEX_HOME: '/opt/codex', CLAUDE_CONFIG_DIR: '/opt/claude' },
    });
    expect(roots.claude).toEqual(['/opt/claude/projects', '/home/me/.claude/projects']);
    expect(roots.codex[0]).toBe('/opt/codex/sessions');
    expect(roots.codex).toContain('/home/me/.config/codex/sessions');
    expect(roots.codex.filter((dir) => dir === '/home/me/.config/Cindy/codex-home/sessions')).toHaveLength(1);
    expect(roots.pi.filter((dir) => dir === '/home/me/.config/Cindy/pi-agent-home/sessions')).toHaveLength(1);
  });

  it('uses APPDATA for the Codex app on Windows and skips it when unknown', () => {
    const win = workbenchSessionRoots({
      homeDir: 'C:/Users/me',
      appDataDir: null,
      userDataDir: null,
      platform: 'win32',
      env: { APPDATA: 'C:/Users/me/AppData/Roaming' },
    });
    expect(win.codex.some((dir) => dir.includes('Roaming') && dir.endsWith('sessions'))).toBe(true);
    expect(win.pi).toEqual([]);
    const bare = workbenchSessionRoots({ homeDir: 'C:/Users/me', appDataDir: null, userDataDir: null, platform: 'win32', env: {} });
    expect(bare.codex).toHaveLength(2);
  });

  it('adds the current account codex-accounts folder of every profile, and nothing for other or missing owners', () => {
    const owner = 'a'.repeat(64);
    const roots = workbenchSessionRoots({
      homeDir: '/Users/me',
      appDataDir: SUPPORT,
      userDataDir: `${SUPPORT}/CindyGlobal-dev2-bot-workbench`,
      platform: 'darwin',
      env: {},
      codexAccountOwner: owner,
    });
    expect(roots.codexAccounts).toEqual([
      `${SUPPORT}/CindyGlobal-dev2-bot-workbench/codex-accounts/${owner}`,
      `${SUPPORT}/Cindy/codex-accounts/${owner}`,
      `${SUPPORT}/CindyGlobal/codex-accounts/${owner}`,
      `${SUPPORT}/CindyDev/codex-accounts/${owner}`,
      `${SUPPORT}/xdt-maker/codex-accounts/${owner}`,
    ]);
    const base = { homeDir: '/Users/me', appDataDir: SUPPORT, userDataDir: null, platform: 'darwin', env: {} };
    expect(workbenchSessionRoots(base).codexAccounts).toEqual([]);
    expect(workbenchSessionRoots({ ...base, codexAccountOwner: '../../etc' }).codexAccounts).toEqual([]);
  });
});
