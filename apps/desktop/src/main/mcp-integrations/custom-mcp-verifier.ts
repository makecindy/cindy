import { AppConnection } from '../mcp-apps/connection.js';
import { validateMcpEndpoint } from './custom-mcp-fetch.js';
import type { CustomMcpConfig } from '../../shared/customMcp.js';

export async function verifyCustomMcp(
  config: CustomMcpConfig,
  token: string,
  signal: AbortSignal,
): Promise<void> {
  validateMcpEndpoint(config.url);
  const headers = { ...config.headers };
  if (token && !Object.keys(headers).some((name) => name.toLowerCase() === 'authorization'))
    headers.Authorization = 'Bearer ' + token;
  const connection = new AppConnection({
    ...config,
    headers,
    secure: true,
    responseLimit: 2 * 1024 * 1024,
  });
  const deadline = AbortSignal.timeout(15_000);
  const combined = AbortSignal.any([signal, deadline]);
  const abort = () => {
    void connection.close().catch(() => {});
  };
  combined.addEventListener('abort', abort, { once: true });
  try {
    combined.throwIfAborted();
    const client = await connection.getClient(combined);
    // Initialization alone is a valid verification for a resource-only server.
    if (client.getServerCapabilities()?.tools)
      await connection.tools(combined, { pages: 10, tools: 1000 });
    combined.throwIfAborted();
  } catch (error) {
    const code =
      connection.safeErrorCode ??
      (deadline.aborted
        ? 'CONNECT_TIMEOUT'
        : error instanceof Error && error.message === 'MCP_APP_TOOL_LIST_TOO_LARGE'
          ? 'RESPONSE_LIMIT'
          : 'PROTOCOL_MISMATCH');
    throw new Error(code);
  } finally {
    combined.removeEventListener('abort', abort);
    await connection.close().catch(() => {});
  }
}
