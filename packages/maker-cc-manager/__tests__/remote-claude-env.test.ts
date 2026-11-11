import { describe, expect, it } from 'vitest';

import {
  buildRemoteClaudeSdkEnv,
  prepareRemoteClaudeEnv,
  resolveRemoteClaudeConfigDir,
  stripSensitiveAnthropicEnv,
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

  it('preserves the remote HOME/PATH for SDKs that replace the process environment', () => {
    const daemonEnv = {
      HOME: '/home/remote',
      PATH: '/home/remote/.xdt-server/v1/node/bin:/usr/bin',
      LANG: 'en_US.UTF-8',
      UNSET: undefined,
      ANTHROPIC_API_KEY: 'stale-remote-key',
      ANTHROPIC_AUTH_TOKEN: 'stale-remote-bearer',
      CLAUDE_CODE_OAUTH_TOKEN: 'stale-remote-oauth',
      CLAUDE_CODE_OAUTH_SCOPES: 'stale-scope',
      CLAUDE_CODE_SUBSCRIPTION_TYPE: 'stale-tier',
      CLAUDE_CODE_RATE_LIMIT_TIER: 'stale-rate-limit',
      CLAUDE_CODE_SUBAGENT_MODEL: 'stale-model',
      ANTHROPIC_BASE_URL: 'https://stale.example',
      ANTHROPIC_CUSTOM_HEADERS: 'Authorization: Bearer stale',
      CLAUDE_CONFIG_DIR: '/home/remote/.claude',
      CLAUDE_CODE_ENTRYPOINT: 'sdk-ts',
    };
    const remoteEnv = buildRemoteClaudeSdkEnv({
      ANTHROPIC_API_KEY: 'session-key',
      CLAUDE_CODE_ENTRYPOINT: 'claude-desktop',
      CLAUDE_CONFIG_DIR: '/home/remote/.xdt-server/v1/claude-home',
    }, daemonEnv);

    expect(remoteEnv).toEqual({
      HOME: daemonEnv.HOME,
      PATH: daemonEnv.PATH,
      LANG: daemonEnv.LANG,
      ANTHROPIC_API_KEY: 'session-key',
      CLAUDE_CODE_ENTRYPOINT: 'claude-desktop',
      CLAUDE_CONFIG_DIR: '/home/remote/.xdt-server/v1/claude-home',
    });
    expect(daemonEnv.CLAUDE_CODE_OAUTH_TOKEN).toBe('stale-remote-oauth');
  });

  it('strips credentials at boot without removing the remote OS environment', () => {
    const daemonEnv = {
      HOME: '/home/remote',
      PATH: '/usr/bin',
      ANTHROPIC_API_KEY: 'stale-key',
      CINDY_CLAUDE_ACCOUNT_PROVIDER_ID: 'stale-account',
      CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1',
    };
    expect(stripSensitiveAnthropicEnv(daemonEnv)).toEqual([
      'ANTHROPIC_API_KEY',
      'CINDY_CLAUDE_ACCOUNT_PROVIDER_ID',
      'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
    ]);
    expect(daemonEnv).toEqual({ HOME: '/home/remote', PATH: '/usr/bin' });
  });
});
