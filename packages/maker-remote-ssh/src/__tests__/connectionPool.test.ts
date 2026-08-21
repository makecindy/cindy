import { describe, expect, it, vi } from 'vitest';

import { ConnectionPool } from '../ConnectionPool.js';
import type { HostConfig } from '../types.js';

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function sshHost(alias: string): HostConfig {
  return {
    id: `ssh-config:${alias}`,
    alias,
    displayName: alias,
    hostname: `${alias}.example.com`,
    port: 22,
    user: 'deploy',
    authMethod: 'agent',
    source: 'ssh-config',
  };
}

function cindyHost(profileId: string): HostConfig {
  return {
    id: `cindy:${profileId}`,
    displayName: `Cindy ${profileId}`,
    hostname: '192.0.2.10',
    port: 22,
    user: 'deploy',
    authMethod: 'agent',
    source: 'manual',
  };
}

describe('ConnectionPool HostRef hydration', () => {
  it('follows the latest source order while preserving existing host objects', async () => {
    const pool = new ConnectionPool({ logger });
    await pool.hydrate([sshHost('alpha'), sshHost('beta'), cindyHost('local')]);
    const alpha = pool.get('alpha');

    await pool.hydrate([sshHost('beta'), sshHost('alpha'), cindyHost('local')]);

    expect(pool.list().map((snapshot) => snapshot.config.id)).toEqual([
      'ssh-config:beta',
      'ssh-config:alpha',
      'cindy:local',
    ]);
    expect(pool.get('alpha')).toBe(alpha);
  });

  it('keeps complete HostRefs authoritative while resolving old reserved-prefix aliases', async () => {
    const pool = new ConnectionPool({ logger });
    await pool.hydrate([sshHost('cindy:build')]);

    // This is a pre-HostRef persisted alias, not a new external selector.
    // It remains resolvable as long as the matching SSH alias is active.
    expect(pool.get('cindy:build')?.config.alias).toBe('cindy:build');
    expect(pool.get('ssh-config:cindy:build')?.config.alias).toBe('cindy:build');

    await pool.hydrate([sshHost('cindy:build'), cindyHost('build')]);
    // If a real Cindy profile with the same text exists, the complete
    // namespace remains authoritative and cannot be redirected to SSH.
    expect(pool.get('cindy:build')?.config.source).toBe('manual');
  });

  it('disconnects a reused host before applying refreshed connection fields', async () => {
    const pool = new ConnectionPool({ logger });
    await pool.hydrate([sshHost('alpha')]);
    const alpha = pool.get('alpha');
    expect(alpha).toBeDefined();
    const disconnect = vi.spyOn(alpha!, 'disconnect');

    await pool.hydrate([{ ...sshHost('alpha'), hostname: 'new-target.example.com' }]);

    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(pool.get('alpha')).toBe(alpha);
    expect(pool.get('alpha')?.config.hostname).toBe('new-target.example.com');
  });

  it('rejects duplicate SSH aliases before replacing the live registry', async () => {
    const pool = new ConnectionPool({ logger });
    await pool.hydrate([sshHost('alpha')]);

    await expect(pool.hydrate([
      sshHost('duplicate'),
      { ...sshHost('other'), alias: 'duplicate' },
    ])).rejects.toThrow('duplicate ssh alias: duplicate');
    expect(pool.list().map((snapshot) => snapshot.config.id)).toEqual(['ssh-config:alpha']);
  });
});
