import { describe, expect, it, vi } from 'vitest';
import type { LiziMcpProvider, LiziMcpSessionContext } from '@cindy/mcps';
import type { InstalledGhost } from '../../../shared/ghost.js';
import { HostServiceCatalog, createHostServiceToolExecutor } from '../hostServiceCatalog.js';

// Item 28, unit: discover the actual supplied services, never just a manifest
// promise. Existing gateway tests only exercised individual calls. Minimal
// inputs are one supplied browser and a helper lacking history handlers.
const context: LiziMcpSessionContext = { agentKind: 'claude-code', workingDir: '' };
function provider(name: string, tools: Array<{ name: string; category: string }>, enabled = () => true) {
  const execute = vi.fn(async () => ({ content: [] }));
  const close = vi.fn(async () => {});
  const value: LiziMcpProvider = { name, isEnabled: enabled, toClaudeSdkConfig: () => null,
    toHostTools: () => ({ list: () => tools, describe: tool => tools.find(item => item.name === tool),
      call: execute, close }) };
  return { value, execute, close };
}

describe('Host service discovery', () => {
  // Unit, performance regression: registering providers at startup built MCP
  // runtimes even without a discovery consumer. One unused provider suffices;
  // the existing cases started by discovering services and missed this path.
  it('does not construct or probe unused providers and caches metadata until replacement', () => {
    const enabled = vi.fn(() => true);
    const browser = provider('cindy_browser', [{ name: 'browser', category: 'browser' }], enabled);
    const create = vi.spyOn(browser.value, 'toHostTools');
    const catalog = new HostServiceCatalog();
    expect(catalog.replace([browser.value])).toBe(false);
    expect(catalog.replace([browser.value])).toBe(false);
    expect(create).not.toHaveBeenCalled();
    expect(enabled).not.toHaveBeenCalled();
    expect(browser.close).not.toHaveBeenCalled();
    expect(catalog.available('browser', context)).toBe(true);
    expect(catalog.list(context).find(service => service.group === 'browser')?.tools).toEqual(['browser']);
    expect(create).toHaveBeenCalledOnce();
    expect(browser.close).toHaveBeenCalledOnce();
    catalog.replace([]);
    expect(catalog.available('browser', context)).toBe(false);
  });
  it('invalidates setup only when supplied services or live default enablement change', () => {
    let enabled = true;
    const browser = provider('cindy_browser', [{ name: 'browser', category: 'browser' }], () => enabled);
    const catalog = new HostServiceCatalog();
    expect(catalog.replace([browser.value])).toBe(false);
    // Once discovery has a consumer, retain change notifications and live defaults.
    catalog.list(context);
    expect(catalog.replace([{ ...browser.value }])).toBe(false);
    enabled = false;
    expect(catalog.replace([browser.value])).toBe(true);
    expect(catalog.replace([browser.value])).toBe(false);
  });

  it('reflects supplied handlers and live enablement without executing tools or retaining a runtime', () => {
    let enabled = true;
    const browser = provider('cindy_browser', [{ name: 'browser', category: 'browser' }], () => enabled);
    const helper = provider('cindy_helper', [{ name: 'terminal_list', category: 'terminal' }, { name: 'stop_session', category: 'control' }]);
    const catalog = new HostServiceCatalog();
    catalog.replace([browser.value, helper.value]);
    expect(catalog.list(context)).toEqual(expect.arrayContaining([
      expect.objectContaining({ group: 'browser', available: true }),
      expect.objectContaining({ group: 'terminal', available: true }),
      expect.objectContaining({ group: 'control', available: true, tools: ['stop_session'] }),
      expect.objectContaining({ group: 'history', available: false }),
      expect.objectContaining({ group: 'scheduler', available: false }),
    ]));
    enabled = false;
    expect(catalog.available('browser', context)).toBe(false);
    expect(catalog.available('future-service', context)).toBe(false);
    expect(browser.execute).not.toHaveBeenCalled();
    expect(helper.execute).not.toHaveBeenCalled();
    expect(browser.close).toHaveBeenCalledOnce();
    catalog.replace([]);
    expect(catalog.list(context).every(service => !service.available)).toBe(true);
  });

  it('projects only the attested plugin’s declarations and current approvals', async () => {
    const catalog = new HostServiceCatalog();
    catalog.replace([provider('cindy_browser', [{ name: 'browser', category: 'browser' }]).value]);
    const caller = { kind: 'plugin' as const, pluginId: 'discovery', dataOwnerId: 'owner', ownerGeneration: 1 };
    const ghost = { enabled: true, approval: { state: 'approved', revision: 'r1' },
      manifest: { agent: { hostTools: ['discovery', 'browser', 'ssh'] } }, approvedHostToolGroups: ['discovery', 'browser'] } as InstalledGhost;
    let active = true;
    const execute = createHostServiceToolExecutor(catalog, { getGhost: () => ghost,
      pluginCall: () => active ? { caller, server: 'cindy_helper', tool: 'host_services', argsJson: '{}', assertCurrent() {} } : undefined });
    const result = await execute.list({ ...context, hostCaller: caller });
    expect(result).toMatchObject({ scope: 'local', services: expect.arrayContaining([
      expect.objectContaining({ group: 'browser', available: true, declared: true, approved: true }),
      expect.objectContaining({ group: 'ssh', available: false, declared: true, approved: false }),
      expect.objectContaining({ group: 'computer', declared: false, approved: false }),
    ]) });
    ghost.approvedHostToolGroups = ['discovery'];
    expect(await execute.list({ ...context, hostCaller: caller })).toMatchObject({ services: expect.arrayContaining([
      expect.objectContaining({ group: 'browser', approved: false }),
    ]) });
    active = false;
    expect(() => execute.list({ ...context, hostCaller: caller })).toThrow('PERMISSION_DENIED');
    expect(execute.list(context)).toMatchObject({ scope: 'local', services: expect.arrayContaining([
      expect.objectContaining({ group: 'browser', available: true }),
    ]) });
    expect(JSON.stringify(execute.list(context))).not.toContain('approved');
  });
});
