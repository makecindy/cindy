import type { Logger, MakerMemoryManager, McpProvider } from '@cindy/maker-core';
import { createCindyMemoryMcpServer } from '../../../packages/lizi-mcps/src/cindy_memoryMcpServer.js';

export interface MemoryMcpProviderOptions {
  getManager(): MakerMemoryManager;
  logger?: Logger;
}

/** Headless-only adapter around Cindy's existing Maker Memory MCP factory. */
export function createMemoryMcpProvider(options: MemoryMcpProviderOptions): McpProvider {
  return {
    name: 'cindy_memory',
    isEnabled: () => options.getManager().isEnabled(),
    toClaudeSdkConfig: (context) => ({
      type: 'sdk',
      name: 'cindy_memory',
      instance: createCindyMemoryMcpServer({
        getManager: options.getManager,
        workdir: context.workingDir,
        ...(options.logger ? { logger: options.logger } : {}),
      }),
    }),
  };
}
