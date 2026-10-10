import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { discoverCursorAgentBinarySync } from '../cursor-binary-discovery.js';
import { createDesktopCursorAuthAdapter, parseCursorAuthStatus } from '../cursor-auth-adapter.js';

describe('Cursor native host boundary', () => {
  it('finds the native user-installed executable without scanning relative PATH entries', () => {
    const home = '/users/test';
    const found = path.posix.join(home, '.local', 'bin', 'cursor-agent');
    const seen: string[] = [];
    expect(discoverCursorAgentBinarySync({ platform: 'darwin', home, pathEnv: '.:/opt/bin',
      executable: candidate => { seen.push(candidate); return candidate === found; },
    })).toEqual({ installed: true, binaryPath: found });
    expect(seen).toEqual([found]);
  });
  it('uses Windows path semantics and accepts only native executables', () => {
    const expected = path.win32.join('C:\\Tools', 'cursor-agent.exe');
    expect(discoverCursorAgentBinarySync({ platform: 'win32', home: 'C:\\Users\\test',
      pathEnv: '.;C:\\Tools', executable: candidate => candidate === expected,
    })).toEqual({ installed: true, binaryPath: expected });
  });
  it('accepts canonical agent only in known install roots, never an unrelated PATH binary', () => {
    const canonical = path.posix.join('/users/test', '.local', 'bin', 'agent');
    expect(discoverCursorAgentBinarySync({ platform: 'linux', home: '/users/test',
      pathEnv: '/some/tool', executable: candidate => candidate === canonical,
    })).toEqual({ installed: true, binaryPath: canonical });
    expect(discoverCursorAgentBinarySync({ platform: 'linux', home: '/users/test',
      pathEnv: '/some/tool', executable: candidate => candidate === '/some/tool/agent',
    })).toEqual({ installed: false });
    const windows = path.win32.join('C:\\Local', 'cursor-agent', 'agent.exe');
    expect(discoverCursorAgentBinarySync({ platform: 'win32', home: 'C:\\Users\\test',
      localAppData: 'C:\\Local', executable: candidate => candidate === windows,
    })).toEqual({ installed: true, binaryPath: windows });
  });
  it('reports an absent binary without silently selecting another harness', () => {
    expect(discoverCursorAgentBinarySync({ platform: 'linux', home: '/users/test',
      pathEnv: '.', executable: () => false,
    })).toEqual({ installed: false });
  });
  it('does not treat a signed-out response as authenticated', () => {
    expect(parseCursorAuthStatus('Not logged in').authenticated).toBe(false);
    expect(parseCursorAuthStatus('Logged in as test@example.invalid').authenticated).toBe(true);
    expect(parseCursorAuthStatus('{"isAuthenticated":true}').authenticated).toBe(true);
    expect(parseCursorAuthStatus('broken response').authenticated).toBe(false);
  });
  it('never reads, copies, logs in, or deletes native credentials', async () => {
    const adapter = createDesktopCursorAuthAdapter('/unused/cursor-agent', async () => 'Logged in');
    expect(await adapter.getState()).toMatchObject({ authenticated: true });
    expect(await adapter.getAuthEnv()).toEqual({});
    expect(await adapter.getOneShotAuth?.()).toBeNull();
    expect(await adapter.triggerLogin()).toMatchObject({ authenticated: false });
    await expect(adapter.logout()).rejects.toThrow('cursor-agent logout');
  });
});
