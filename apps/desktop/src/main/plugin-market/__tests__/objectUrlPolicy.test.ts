import { beforeEach, describe, expect, it, vi } from 'vitest';
const host = vi.hoisted(() => ({ packaged: false, endpoint: 'http://127.0.0.1:43340' }));
vi.mock('electron', () => ({ app: { get isPackaged() { return host.packaged; } } }));
vi.mock('../../clientEndpointsService.js', () => ({ getClientEndpoint: () => host.endpoint }));
import { pluginObjectUrlAllowed, pluginObjectUrlOptions } from '../objectUrlPolicy';

beforeEach(() => { host.packaged = false; host.endpoint = 'http://127.0.0.1:43340'; });
describe('Host delivery object policy', () => {
  it('enables HTTP only for an unpackaged Host explicitly configured with the same loopback origin', () => {
    expect(pluginObjectUrlAllowed('http://127.0.0.1:43340/dev-local/object?key=fixture', pluginObjectUrlOptions())).toBe(true);
    expect(pluginObjectUrlAllowed('http://127.0.0.1:43341/dev-local/object', pluginObjectUrlOptions())).toBe(false);
    expect(pluginObjectUrlAllowed('http://remote.example/dev-local/object', pluginObjectUrlOptions())).toBe(false);
  });
  it('keeps a packaged Host HTTPS-only even with loopback configuration', () => {
    host.packaged = true;
    expect(pluginObjectUrlOptions()).toBeUndefined();
    expect(pluginObjectUrlAllowed('http://127.0.0.1:43340/dev-local/object', pluginObjectUrlOptions())).toBe(false);
    expect(pluginObjectUrlAllowed('https://downloads.example/package', pluginObjectUrlOptions())).toBe(true);
  });
  it.each(['https://plugins.example', 'http://plugins.example', 'invalid', 'http://user@127.0.0.1:43340'])(
    'does not grant local HTTP from a different endpoint configuration: %s', endpoint => {
      host.endpoint = endpoint;
      expect(pluginObjectUrlOptions()).toBeUndefined();
      expect(pluginObjectUrlAllowed('http://127.0.0.1:43340/dev-local/object', pluginObjectUrlOptions())).toBe(false);
    },
  );
});
