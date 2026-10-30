import { describe, expect, it, vi } from 'vitest';

import { PiRpcProcess, createPiStdioTransport } from './rpc-client.js';

describe('Pi startup diagnostics over real stdio (#4625)', () => {
  it('carries drained stderr into the pending and subsequent startup requests', async () => {
    const logger = {
      trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(),
      error: vi.fn(), fatal: vi.fn(), child: vi.fn(),
    };
    logger.child.mockReturnValue(logger);
    // No Pi account, user configuration, package install, or network required.
    // Exercise the real child-process exit/stdio framing path with a failing CLI.
    const transport = createPiStdioTransport({
      binaryPath: process.execPath,
      args: ['-e', `process.stderr.write('Error: Failed to load extension "placeholder"\\n');
        process.stderr.write('Hint: Start without extensions using "pi -ne".');
        process.exitCode = 1;`],
      cwd: process.cwd(), env: {}, logger,
    });
    const proc = new PiRpcProcess({ transport, logger, onEvent: vi.fn(), onExit: vi.fn() });
    try {
      await expect(proc.request({ type: 'get_state' })).rejects.toThrow(
        'Error: Failed to load extension "placeholder"\nHint: Start without extensions using "pi -ne".',
      );
      await expect(proc.request({ type: 'get_state' })).rejects.toThrow('code=1');
    } finally {
      await proc.close();
    }
  });
});
