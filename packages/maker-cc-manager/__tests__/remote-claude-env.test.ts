import { describe, expect, it } from 'vitest';

import {
  prepareRemoteClaudeEnv,
  resolveRemoteClaudeConfigDir,
} from '../src/remote-claude-env.js';

describe('remote Claude environment', () => {
  it('resolves the Cindy-managed config directory under the remote POSIX home', () => {
    expect(resolveRemoteClaudeConfigDir('/Users/david')).toBe(
      '/Users/david/.xdt-server/v1/claude-home',
    );
  });

  it('replaces a Windows controller path without mutating the input env', () => {
    const controllerEnv = {
      ANTHROPIC_API_KEY: 'sk-gw',
      CLAUDE_CONFIG_DIR: 'C:\\Users\\Admin\\AppData\\Roaming\\Cindy-dev2\\claude-home',
    };

    const remoteEnv = prepareRemoteClaudeEnv(controllerEnv, '/Users/david');

    expect(remoteEnv).toEqual({
      ANTHROPIC_API_KEY: 'sk-gw',
      CLAUDE_CONFIG_DIR: '/Users/david/.xdt-server/v1/claude-home',
    });
    expect(controllerEnv.CLAUDE_CONFIG_DIR).toContain('C:\\Users\\Admin');
  });
});
