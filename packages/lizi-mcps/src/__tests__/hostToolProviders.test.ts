import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createBrowserMcpServer } from '../browser/server.js';
import { createComputerMcpServer } from '../computer/server.js';
import { createSshMcpServer } from '../cindy_sshMcpServer.js';
import { createCindyDocsMcpServer } from '../cindy_docsMcpServer.js';
import { runWithLiziMcpSessionContext } from '../session-context.js';
import type { HostToolRuntime } from '../host-tool-runtime.js';
import type { LiziMcpSessionContext } from '../types.js';

// Item 26, unit: actual server factories and validated handlers are callable
// without an Agent Session. Existing MCP transport tests cannot detect a missing
// in-process adapter or accidental inheritance of an ambient task's directory.
const context: LiziMcpSessionContext = { agentKind: 'claude-code', workingDir: '',
  hostCaller: { kind: 'plugin', pluginId: 'service-test', dataOwnerId: 'owner', ownerGeneration: 1 } };
context.getSessionContext = () => context;
const payload = async (runtime: HostToolRuntime, name: string, args: Record<string, unknown> = {}) => {
  const result = await runtime.call(name, args);
  return JSON.parse(result.content.find(item => item.type === 'text')!.text!);
};

describe('shared Host service adapters', () => {
  it('uses browser validation and does not attribute a plugin request to an ambient task', async () => {
    const runtime = createBrowserMcpServer({ getRuntime: () => ({
      call: async request => ({ ok: true, action: request.action, data: { received: request } }),
    }) }).hostTools;
    try {
      const result = await runWithLiziMcpSessionContext({ agentKind: 'codex', workingDir: '/unrelated', sessionId: 'another-task' },
        () => payload(runtime, 'browser', { action: 'status' }));
      expect(result.ok).toBe(true);
      expect(JSON.stringify(result)).not.toContain('another-task');
      expect((await payload(runtime, 'browser', { action: 'nonexistent' })).errorCode).toBe('INVALID_ARGS');
      expect(runtime.describe('request_input_handoff')).toBeUndefined();
    } finally { await runtime.close(); }
  });

  it('retains computer validation and session hotkey protection', async () => {
    const runtime = createComputerMcpServer({
      getStatus: async () => ({ installed: true, executablePath: null, version: 'test', daemonRunning: true, installCommand: '', docsUrl: '' }),
      callTool: async () => { throw new Error('a blocked key must not reach the driver'); },
    }, { getSessionContext: () => context }).hostTools;
    try {
      expect((await payload(runtime, 'status')).ok).toBe(true);
      expect((await payload(runtime, 'hotkey', { pid: 123, keys: ['ctrl', 'cmd', 'q'] })).errorCode).toBe('HOTKEY_BLOCKED');
      expect((await payload(runtime, 'status', { unknown: true })).errorCode).toBe('INVALID_ARGS');
    } finally { await runtime.close(); }
  });

  it('uses the existing SSH pool and schema without returning authentication values', async () => {
    const runtime = createSshMcpServer({
      getPool: async () => ({ list: () => [], get: () => undefined }), ensureReady: async () => {},
      addHost: async () => {}, reloadConfig: async () => ({ diagnostic: null, warningCount: 0 }),
      redactSensitiveText: (_snapshot, text) => text,
    }).hostTools;
    try {
      expect(await payload(runtime, 'ssh_list_hosts')).toMatchObject({ ok: true, hosts: [] });
      expect((await payload(runtime, 'ssh_exec', { command: 'pwd' })).errorCode).toBe('INVALID_ARGS');
      expect(runtime.describe('ssh_exec')?.category).toBe('ssh');
    } finally { await runtime.close(); }
  });

  it('reads only the plugin document root and refuses traversal under an unrelated ambient task', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-docs-provider-'));
    const pluginContext = { ...context, agentKind: 'claude-code' as const, workingDir: root };
    pluginContext.getSessionContext = () => pluginContext;
    const runtime = createCindyDocsMcpServer({}, pluginContext).hostTools;
    try {
      await fs.writeFile(path.join(root, 'own.csv'), 'name,count\nExample,7\n');
      const result = await runWithLiziMcpSessionContext({ agentKind: 'codex', workingDir: '/unrelated', sessionId: 'another-task' },
        () => payload(runtime, 'read_sheet', { path: 'own.csv' }));
      expect(result.ok).toBe(true);
      expect(JSON.stringify(result)).toContain('Example');
      expect((await payload(runtime, 'read_sheet', { path: '../outside.csv' })).errorCode).toBe('PATH_NOT_ALLOWED');
      expect(runtime.describe('make_docx')).toBeUndefined();
    } finally { await runtime.close(); await fs.rm(root, { recursive: true, force: true }); }
  });
});
