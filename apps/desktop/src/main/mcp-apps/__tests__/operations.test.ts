import { describe, expect, it, vi } from 'vitest';
import { handleMcpAppOperation, handleMcpAppFrameOperation } from '../operations.js';
import type { McpAppsHost } from '../host.js';
function fixture() {
  const document = { viewId: 'view', html: '<!doctype html><p>Private App content</p>',
    csp: "default-src 'none'; connect-src https://private-app.example.invalid", prefersBorder: true,
    policy: { connectDomains: ['https://private-app.example.invalid'] } };
  const api = {
    open: vi.fn(async () => document),
    dispatch: vi.fn(),
    poll: vi.fn(async () => []),
    context: vi.fn(),
    teardown: vi.fn(),
    cancelOpen: vi.fn(),
    displayMode: vi.fn(),
    linkResult: vi.fn(),
    authorizeLink: vi.fn(async () => ({ authorized: true, validForMs: 30_000 })),
  };
  const host = api as unknown as McpAppsHost;
  const local = {
    supply: vi.fn(),
    mount: vi.fn(() => 'mounted'),
    unmount: vi.fn(),
    assertCaller: vi.fn(),
    openLink: vi.fn(async () => {}),
  };
  return { host, api, local, document };
}
describe('task-bound MCP App operations', () => {
  it('binds every operation to the verified caller and exact task', async () => {
    const f = fixture();
    expect(
      await handleMcpAppOperation(
        f.host,
        'renderer:1',
        'task',
        { op: 'open', clientId: 'card', context: { theme: 'dark' } },
        f.local,
      ),
    ).toEqual({ viewId: 'view', transport: 'sandbox', prefersBorder: true });
    expect(f.api.open).toHaveBeenCalledWith('renderer:1', 'task', 'card', { theme: 'dark' }, undefined);
    expect(f.local.supply).toHaveBeenCalledWith(f.document, 'renderer:1');
    await handleMcpAppOperation(f.host, 'device:phone', 'task', {
      op: 'poll',
      viewId: 'view',
      after: 4,
    });
    expect(f.api.poll).toHaveBeenCalledWith('device:phone', 'task', 'view', 4);
    await handleMcpAppOperation(f.host, 'device:phone', 'task', {
      op: 'link-result',
      viewId: 'view',
      linkId: 'link',
      success: false,
    });
    expect(f.api.linkResult).toHaveBeenCalledWith('device:phone', 'task', 'view', 'link', false);
    await handleMcpAppOperation(f.host, 'device:phone', 'task', { op: 'cancel-open', openId: 'attempt' });
    expect(f.api.cancelOpen).toHaveBeenCalledWith('device:phone', 'task', 'attempt');
  });
  it('keeps the complete document on the authenticated device transport for Mobile', async () => {
    const f = fixture();
    expect(await handleMcpAppOperation(f.host, 'device:phone', 'task', {
      op: 'open', clientId: 'card',
    })).toEqual(f.document);
    expect(f.api.open).toHaveBeenCalledWith('device:phone', 'task', 'card', {}, undefined);
    expect(f.local.supply).not.toHaveBeenCalled();
  });
  it.each([
    { op: 'message', viewId: 'view', message: { jsonrpc: '2.0', id: 1, method: 'tools/call' } },
    { op: 'poll', viewId: 'view' },
    { op: 'link-result', viewId: 'view', linkId: 'link', success: true },
    { op: 'authorize-link', viewId: 'view', linkId: 'link' },
    { op: 'mount-remote', document: { viewId: 'view', html: '<p>forged</p>' } },
    { op: 'unmount-remote', viewId: 'view' },
    { op: 'open-link', viewId: 'view', url: 'https://example.org' },
  ])('rejects top-Renderer access to the App transport: %j', async (input) => {
    const f = fixture();
    await expect(handleMcpAppOperation(f.host, 'renderer:1', 'task', input, f.local))
      .rejects.toThrow('MCP_APP_FRAME_REQUIRED');
    Object.values(f.api).forEach((call) => expect(call).not.toHaveBeenCalled());
  });
  it('binds frame messages to the Main-held View and limits the channel to transport operations', async () => {
    const f = fixture();
    const message = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
    await handleMcpAppFrameOperation(f.host, 'renderer:1', 'task', 'view',
      { op: 'message', viewId: 'forged-view', sessionId: 'forged-task', message }, f.local.openLink);
    expect(f.api.dispatch).toHaveBeenCalledWith('renderer:1', 'task', 'view', message);
    await expect(handleMcpAppFrameOperation(f.host, 'renderer:1', 'task', 'view',
      { op: 'open', clientId: 'other-card' }, f.local.openLink)).rejects.toThrow('MCP_APP_INVALID_REQUEST');
    expect(f.api.open).not.toHaveBeenCalled();
  });
  it.each([
    { op: 'poll', viewId: 'view', after: -1 },
    { op: 'poll', viewId: 'view', after: 1.5 },
    { op: 'authorize-link', viewId: 'view', linkId: '' },
    { op: 'open', clientId: '' },
    { op: 'open', clientId: 'card', context: { theme: 'other' } },
    { op: 'teardown', viewId: 'view', alreadyNotified: 'true' },
    { op: 'context', viewId: 'view', context: { deviceCapabilities: { touch: 'yes' } } },
    { op: 'display-mode', viewId: 'view', mode: 'window' },
    { op: 'arbitrary-shell', command: 'echo' },
  ])('rejects malformed operations before reaching the Host: %j', async (raw) => {
    const f = fixture();
    await expect(handleMcpAppOperation(f.host, 'renderer:1', 'task', raw, f.local)).rejects.toThrow(
      'MCP_APP_INVALID_REQUEST',
    );
    Object.values(f.api).forEach((call) => expect(call).not.toHaveBeenCalled());
  });
  it('forbids remote requests from mounting HTML or opening links on the execution computer', async () => {
    const f = fixture();
    for (const raw of [
      { op: 'mount-remote', document: f.document },
      { op: 'unmount-remote', viewId: 'view' },
      { op: 'open-link', viewId: 'view', url: 'https://example.org' },
    ])
      await expect(handleMcpAppOperation(f.host, 'device:phone', 'task', raw)).rejects.toThrow(
        'MCP_APP_INVALID_REQUEST',
      );
  });
});
