import { describe, expect, it, vi } from 'vitest';
import { createSessionToolCatalogExecutor } from '../sessionToolCatalog.js';

// Unit: execute the Desktop callback used by the real helper registry. Protect
// the approved-Node MCP boundary and native-only reads; no previous catalog
// callback existed. Minimal input: one HTTP server or one live MCP server name.
describe('session native tool catalog', () => {
  function fixture(node = false) {
    const session = { agentKind: 'pi', remoteHostId: null,
      readMcpServerTools: vi.fn(async () => ({ state: 'connected', tools: [{ name: 'search' }] })),
      callNativeToolCatalog: vi.fn(async () => ['read']) };
    const assertCurrent = vi.fn(async () => {});
    const getSession = vi.fn(async () => session);
    const call = createSessionToolCatalogExecutor({ getSession,
      pluginCall: () => ({ caller: { pluginId: 'catalog' }, assertCurrent: () => {} }),
      getGhost: () => ({ enabled: true, approval: { state: 'approved' }, manifest: { ...(node ? { node: {} } : {}) } }),
    });
    return { session, getSession, assertCurrent, call };
  }
  it('does not query a session until explicitly called, then uses its existing MCP reader', async () => {
    const f = fixture();
    expect(f.getSession).not.toHaveBeenCalled();
    expect(await f.call({ sessionId: 'target', method: 'readMcpServerTools', args: ['external'] }, f.assertCurrent))
      .toEqual({ ok: true, engine: 'pi', result: { state: 'connected', tools: [{ name: 'search' }] } });
    expect(f.session.readMcpServerTools).toHaveBeenCalledWith('external');
    expect(f.session.callNativeToolCatalog).not.toHaveBeenCalled();
  });
  it.each([false, true])('requires existing approved Node permission to add MCP (node=%s)', async node => {
    const f = fixture(node);
    const result = await f.call({ sessionId: 'target', method: 'registerMcpServer', args: ['external', { url: 'http://localhost/mcp' }] }, f.assertCurrent);
    expect(result.ok).toBe(node);
    expect(f.session.callNativeToolCatalog).toHaveBeenCalledTimes(node ? 1 : 0);
  });
  it('allows native active-tool changes without adding process permission', async () => {
    const f = fixture();
    expect((await f.call({ sessionId: 'target', method: 'setActiveTools', args: [['read']] }, f.assertCurrent)).ok).toBe(true);
    expect(f.session.callNativeToolCatalog).toHaveBeenCalledWith('setActiveTools', [['read']]);
  });
  it('does not start or forward to a remote native runtime', async () => {
    const f = fixture();
    f.session.remoteHostId = 'remote' as never;
    expect((await f.call({ sessionId: 'target', method: 'getAllTools', args: [] }, f.assertCurrent)).ok).toBe(false);
    expect(f.session.callNativeToolCatalog).not.toHaveBeenCalled();
  });
});
