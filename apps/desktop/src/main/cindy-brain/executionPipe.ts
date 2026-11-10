import type { GhostPipeDispatcher } from './pipeDispatcher.js';

export interface GhostExecutionPipePorts {
  dispatcher(): GhostPipeDispatcher;
  fetch(id: string, payload: unknown): Promise<unknown>;
  files(id: string, payload: unknown): Promise<unknown>;
  library(id: string, payload: unknown): Promise<unknown>;
  download(id: string, payload: unknown, current: () => boolean): Promise<unknown>;
  node(id: string, payload: unknown, current: () => boolean): Promise<unknown>;
  warn(message: string, details: Record<string, unknown>): void;
}

/** The caller binds identity to a real logic page. Neither platform trusts an
 * id in the payload. Optional presentation/automation requests remain with the
 * broader host router; core execution and receipt pairing have one route. */
export function createGhostExecutionPipe(ports: GhostExecutionPipePorts) {
  return (id: string, payload: unknown, current: () => boolean): Promise<unknown> | undefined => {
    const type = (payload as { type?: unknown } | null)?.type;
    if (!['tool-result', 'tool-progress', 'fetch-request', 'fs-request', 'library-request', 'download-request', 'node-request'].includes(String(type))) return undefined;
    if (!current()) return Promise.reject(new Error('PLUGIN_PAGE_UNAVAILABLE'));
    if (type === 'tool-result' || type === 'tool-progress') {
      const dispatcher = ports.dispatcher();
      const outcome = type === 'tool-result' ? dispatcher.handleToolResult(id, payload) : dispatcher.handleToolProgress(id, payload);
      if (!outcome.accepted) ports.warn(`ghost ${type} rejected`, { id, reason: outcome.reason });
      // Match Desktop: no result-pairing oracle is exposed to sandbox code.
      return Promise.resolve({ ok: true });
    }
    if (type === 'fetch-request') return ports.fetch(id, payload);
    if (type === 'fs-request') return ports.files(id, payload);
    if (type === 'library-request') return ports.library(id, payload);
    if (type === 'download-request') return ports.download(id, payload, current);
    return ports.node(id, payload, current);
  };
}
