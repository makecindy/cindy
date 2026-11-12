import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { appServerRevision, McpAppsHost } from '../host.js';
import type { AppServerConfig } from '../connection.js';

const key = 'a'.repeat(64); // Deliberately invalid test-only vault material.
const config: AppServerConfig = {
  id: 'example', url: 'https://mcp.example.invalid', transport: 'http',
  headers: { Authorization: 'Basic invalid-test-only', 'x-api-key': 'fake-test-secret' },
};

function host(readKey: () => string) {
  return new McpAppsHost({
    owner: () => ({}), config: () => config, revisionKey: readKey,
    readCard: async () => { throw new Error('unused'); },
    writeCard: async () => {}, authorizeTool: async () => {}, sendMessage: async () => {},
  });
}

describe('private MCP App server revisions', () => {
  it('requires a host secret instead of persisting an offline credential verifier', () => {
    const input = JSON.stringify([config.id, config.url, config.transport, config.headers]);
    const revision = appServerRevision(config, key);
    expect(revision).toBe(createHmac('sha256', key)
      .update('cindy:mcp-app-server-revision:v1\0').update(input).digest('hex'));
    expect(revision).not.toBe(createHash('sha256').update(input).digest('hex'));
    expect(revision).not.toBe(appServerRevision(config, 'b'.repeat(64)));
  });

  it('retains the revision across Host recreation with the same vault key', () => {
    const first = host(() => key).serverRevision(config);
    expect(host(() => key).serverRevision({ ...config, headers: { ...config.headers } })).toBe(first);
    expect(first).not.toBe(host(() => 'b'.repeat(64)).serverRevision(config));
  });

  it.each([
    { ...config, url: config.url + '/changed' },
    { ...config, headers: { ...config.headers, Authorization: 'Bearer invalid-test-only-rotated' } },
    { ...config, headers: { ...config.headers, 'x-api-key': 'fake-test-secret-rotated' } },
  ])('still revokes a changed endpoint or credential configuration', (changed) => {
    const current = host(() => key);
    expect(current.serverRevision(changed)).not.toBe(current.serverRevision(config));
  });

  it('fails closed when the injected persistent key cannot be read', () => {
    const current = host(() => { throw new Error('MCP_APP_REVISION_KEY_UNAVAILABLE'); });
    expect(() => current.serverRevision(config)).toThrow('MCP_APP_REVISION_KEY_UNAVAILABLE');
  });
});
