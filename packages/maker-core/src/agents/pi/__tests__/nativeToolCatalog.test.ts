import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { PI_NATIVE_TOOL_CATALOG_SOURCE } from '../native-tool-catalog-source.js';

// Unit: execute the shipped bridge's public Pi API mapping. Existing provider
// refresh tests do not cover tool schemas, active sets, or native MCP mutation.
const sandbox: Record<string, unknown> = {};
runInNewContext(ts.transpileModule(PI_NATIVE_TOOL_CATALOG_SOURCE +
  '\nglobalThis.call = callCindyNativeToolCatalog;', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, sandbox);
const call = sandbox.call as (pi: unknown, method: string, args: unknown[]) => Promise<unknown>;

describe('Pi native tool catalog', () => {
  it('reads native schema without exposing extension paths or executable callbacks', async () => {
    const parameters = { type: 'object', properties: { path: { type: 'string' } } };
    const result = await call({ getAllTools: () => [{ name: 'read', description: 'Read', parameters,
      sourceInfo: { path: '/private/extension.ts' }, reachesTools: () => 'all' }] }, 'getAllTools', []);
    expect(JSON.parse(JSON.stringify(result))).toEqual([{ name: 'read', description: 'Read', parameters }]);
  });
  it('uses the native active set as the result, including ignored unknown names', async () => {
    let active = ['read', 'bash'];
    const pi = { setActiveTools: vi.fn((names: string[]) => { active = names.filter(n => n !== 'unknown'); }),
      getActiveTools: () => active };
    expect(await call(pi, 'setActiveTools', [['read', 'unknown']])).toEqual(['read']);
    expect(pi.setActiveTools).toHaveBeenCalledWith(['read', 'unknown']);
    expect(await call(pi, 'getActiveTools', [])).toBe(active);
  });
  it('passes registration and removal to Pi without a host catalog', async () => {
    const registerMcpServer = vi.fn(), unregisterMcpServer = vi.fn();
    const config = { url: 'http://127.0.0.1:9999/mcp', exposure: 'deferred' };
    await call({ registerMcpServer }, 'registerMcpServer', ['business', config]);
    await call({ unregisterMcpServer }, 'unregisterMcpServer', ['business']);
    expect(registerMcpServer).toHaveBeenCalledWith('business', config);
    expect(unregisterMcpServer).toHaveBeenCalledWith('business');
  });
  it.each(['getAllTools', 'registerTool', 'setActiveTools'])('does not emulate absent %s', async method => {
    await expect(call({}, method, [])).rejects.toThrow('UNSUPPORTED_CAPABILITY');
  });
});
