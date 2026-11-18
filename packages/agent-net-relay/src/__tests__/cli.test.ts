/**
 * #10562: real CLI startup reports a safe stage/code instead of hiding material
 * failures or printing raw error messages. Existing server tests never run CLI.
 * unit: injected filesystem/server errors; no real files, sockets or credentials.
 * Minimal failure: --tls-material with readFile rejecting ENOENT.
 * CLI side effects require an isolated fixture separate from server integration.
 */
import { afterEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  read: vi.fn(), start: vi.fn(),
  output: [] as string[],
}));
vi.mock('node:fs/promises', () => ({ readFile: h.read }));
vi.mock('../server.js', () => ({ startAgentNetRelay: h.start }));
vi.mock('../notificationBridge.js', () => ({ readNotificationBridgeConfig: () => null, createNotificationBridge: async () => undefined }));
vi.mock('../sharingAuth.js', () => ({ createAgentNetSharingAuth: vi.fn() }));
vi.mock('../gateway.js', () => ({ startRelayGateway: vi.fn() }));

afterEach(() => { vi.restoreAllMocks(); h.read.mockReset(); h.start.mockReset(); h.output = []; });

it.each([
  ['ENOENT', 'tls-material', ['--legacy-upstream', 'http://127.0.0.1:47820', '--tls-material', '/private/material.json']],
  ['EACCES', 'bootstrap', ['--bootstrap', '/private/bootstrap.json']],
  ['EADDRINUSE', 'relay', []],
  ['UNTRUSTED_SECRET_VALUE', 'relay', []],
])('reports safe %s diagnostics at %s', async (code, stage, extra) => {
  const argv = process.argv, exitCode = process.exitCode;
  const error = Object.assign(new Error('private address/token/stack must never be logged'), { code });
  h.read.mockRejectedValue(error); h.start.mockRejectedValue(error);
  vi.spyOn(process.stdout, 'write').mockImplementation((value) => { h.output.push(String(value)); return true; });
  try {
    process.argv = ['node', 'agent-net', 'serve', '--data', 'unused-cli-test', ...extra];
    // reset-modules: separate CLI launches must parse fresh argv and run startup again.
    vi.resetModules();
    await import('../cli');
    // Top-level startup is asynchronous; await its observable final error record.
    await vi.waitFor(() => expect(h.output).toHaveLength(1));
    expect(JSON.parse(h.output[0])).toMatchObject({ level: 'error', stage,
      code: code === 'UNTRUSTED_SECRET_VALUE' ? 'STARTUP_FAILED' : code });
    expect(h.output.join('')).not.toMatch(/private|token|stack|UNTRUSTED/);
  } finally { process.argv = argv; process.exitCode = exitCode; }
});
