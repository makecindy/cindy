import { describe, expect, it } from 'vitest';
import { parseGetPluginResponse, parseListPluginsResponse, parsePluginDownloadResponse, PluginProtocolError } from '../delivery.js';

const options = { developmentObjectOrigin: 'http://127.0.0.1:43340' };
const url = `${options.developmentObjectOrigin}/dev-local/object?storageId=fixture&key=package`;
const download = { url, expiresAt: '2026-10-20T00:05:00.000Z', sha256: 'a'.repeat(64), sizeBytes: 42 };
const manifest = { schemaVersion: 2, id: 'example', name: 'Example', version: '1.0.0', kind: 'chip', entry: 'main.js', slots: [] };
const plugin = { id: `c${'a'.repeat(24)}`, ghostId: 'example', name: 'Example', description: null, author: null,
  scope: 'public', organizationId: null, defaultInstall: false,
  currentRelease: { id: 'release', version: '1.0.0', sha256: download.sha256, sizeBytes: 42, publishedAt: download.expiresAt,
    icon: { ...download, mimeType: 'image/png' }, manifest } };

describe('explicit local development delivery objects', () => {
  it('keeps HTTPS as the default for download, catalog icons and detail icons', () => {
    expect(() => parsePluginDownloadResponse(download)).toThrow(PluginProtocolError);
    expect(() => parseListPluginsResponse({ schemaVersion: 2, plugins: [plugin], nextCursor: null })).toThrow(PluginProtocolError);
    expect(() => parseGetPluginResponse({ schemaVersion: 2, plugin })).toThrow(PluginProtocolError);
  });
  it('parses the complete envelopes with an explicit exact loopback object policy', () => {
    expect(parsePluginDownloadResponse(download, options).url).toBe(url);
    expect(parseListPluginsResponse({ schemaVersion: 2, plugins: [plugin], nextCursor: null }, options).plugins[0].currentRelease.icon?.url).toBe(url);
    expect(parseGetPluginResponse({ schemaVersion: 2, plugin }, options).plugin.currentRelease.icon?.url).toBe(url);
    expect(() => parsePluginDownloadResponse({ ...download, sha256: 'bad' }, options)).toThrow(PluginProtocolError);
  });
  it.each([
    'http://127.0.0.1:43341/dev-local/object',
    'http://localhost:43340/dev-local/object',
    'http://remote.example/dev-local/object',
    'http://127.0.0.1:43340/dev-local/member-upload',
    'http://127.0.0.1:43340/dev-local/object/other',
    'http://user:password@127.0.0.1:43340/dev-local/object',
    'http://127.0.0.1:43340/dev-local/object#fragment',
  ])('rejects an object outside the exact development boundary: %s', invalid => {
    expect(() => parsePluginDownloadResponse({ ...download, url: invalid }, options)).toThrow(PluginProtocolError);
  });
  it.each(['http://remote.example', 'http://user@127.0.0.1:43340', 'https://127.0.0.1:43340', 'http://127.0.0.1:43340/other'])(
    'does not turn an invalid development policy into HTTP permission: %s', origin => {
      expect(() => parsePluginDownloadResponse(download, { developmentObjectOrigin: origin })).toThrow(PluginProtocolError);
    },
  );
});
