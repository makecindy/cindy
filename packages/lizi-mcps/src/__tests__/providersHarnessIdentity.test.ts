import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createLiziMcpProviders } from '../providers.js';

const factories = vi.hoisted(() => ({
  scheduler: vi.fn(), helper: vi.fn(), docs: vi.fn(), orca: vi.fn(),
}));
vi.mock('../cindy_schedulerMcpServer.js', () => ({ createSchedulerMcpServer: factories.scheduler }));
vi.mock('../lizi_xdtHelperMcpServer.js', () => ({ createXdtHelperMcpServer: factories.helper }));
vi.mock('../cindy_docsMcpServer.js', () => ({ createCindyDocsMcpServer: factories.docs }));
vi.mock('../orca/index.js', () => ({ createOrcaMcpServer: factories.orca }));
// This test exercises factory context routing, not browser runtime startup.
vi.mock('../browser/index.js', () => ({ createBrowserMcpServer: vi.fn() }));
vi.mock('../computer/index.js', () => ({ createComputerMcpServer: vi.fn() }));
vi.mock('../android/index.js', () => ({ createAndroidMcpServer: vi.fn() }));

beforeEach(() => vi.clearAllMocks());

describe('MCP provider harness identity', () => {
  it.each(['claude-code', 'codex', 'pi', 'cursor'] as const)('preserves %s at every task-aware factory', (agentKind) => {
    const providers = createLiziMcpProviders({
      scheduler: {} as never, xdtHelper: {}, docs: {} as never, orca: {} as never,
    });
    const context = { agentKind, workingDir: '/repo', sessionId: 'task-1', vendorOptions: { orcaRole: 'worker' } };
    for (const provider of providers) provider.toClaudeSdkConfig(context);
    for (const factory of Object.values(factories)) {
      expect(factory).toHaveBeenCalledWith(expect.anything(), expect.objectContaining(context));
    }
  });
});
