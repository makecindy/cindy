import { z } from 'zod';
import { McpUiHostContextSchema } from '@modelcontextprotocol/ext-apps/app-bridge';
import type { McpAppsHost } from './host.js';
import type { McpAppDocument, McpAppSandboxView } from '../../shared/mcpApps.js';
import { isMcpAppLinkAuthorizationCurrent } from '../../shared/mcpApps.js';
import { MCP_APPS_MAX_BYTES, safeAppLink } from './protocol.js';

const id = z.string().min(1).max(256);
export const mcpAppOperationSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('open'), clientId: id, openId: id.optional(), context: McpUiHostContextSchema.default({}) }),
  z.object({ op: z.literal('cancel-open'), openId: id }),
  z.object({ op: z.literal('message'), viewId: id, message: z.unknown() }),
  z.object({ op: z.literal('poll'), viewId: id, after: z.number().int().nonnegative().default(0) }),
  z.object({ op: z.literal('context'), viewId: id, context: McpUiHostContextSchema }),
  z.object({ op: z.literal('teardown'), viewId: id, alreadyNotified: z.boolean().default(false) }),
  z.object({
    op: z.literal('display-mode'),
    viewId: id,
    mode: z.enum(['inline', 'fullscreen', 'pip']),
  }),
  z.object({ op: z.literal('link-result'), viewId: id, linkId: id, success: z.boolean() }),
  z.object({ op: z.literal('authorize-link'), viewId: id, linkId: id }),
  z.object({ op: z.literal('mount-remote'), document: z.unknown() }),
  z.object({ op: z.literal('unmount-remote'), viewId: id }),
  z.object({ op: z.literal('open-link'), viewId: id, url: z.string().max(8192) }),
]);
interface LocalViewDeps {
  supply(document: McpAppDocument, caller: string): void;
}
/** Called only by the protocol's frame-verified channel, with Host-bound task and View IDs. */
export async function handleMcpAppFrameOperation(
  host: McpAppsHost, caller: string, sessionId: string, viewId: string, raw: unknown,
  openLink: (url: string) => Promise<void>,
): Promise<unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('MCP_APP_INVALID_REQUEST');
  const input = raw as Record<string, unknown>;
  if (input.op === 'open-link') {
    const linkId = id.safeParse(input.linkId);
    if (typeof input.url !== 'string' || input.url.length > 8192 || !linkId.success)
      throw new Error('MCP_APP_INVALID_LINK');
    const url = safeAppLink(input.url);
    // A queued event is not a grant: its card or pending link may have expired.
    const requestedAt = performance.now();
    const authorization = await host.authorizeLink(caller, sessionId, viewId, linkId.data, url);
    if (!isMcpAppLinkAuthorizationCurrent(authorization, performance.now() - requestedAt))
      throw new Error('MCP_APP_LINK_NOT_AUTHORIZED');
    await openLink(url);
    return {};
  }
  if (!['message', 'poll', 'link-result'].includes(String(input.op))) throw new Error('MCP_APP_INVALID_REQUEST');
  return handleMcpAppOperation(host, caller, sessionId, { ...input, viewId });
}
export async function handleMcpAppOperation(
  host: McpAppsHost,
  caller: string,
  sessionId: string,
  raw: unknown,
  local?: LocalViewDeps,
): Promise<unknown> {
  if (
    !id.safeParse(sessionId).success ||
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    Buffer.byteLength(JSON.stringify(raw)) > MCP_APPS_MAX_BYTES
  )
    throw new Error('MCP_APP_INVALID_REQUEST');
  const parsed = mcpAppOperationSchema.safeParse(raw);
  if (!parsed.success) throw new Error('MCP_APP_INVALID_REQUEST');
  const input = parsed.data;
  switch (input.op) {
    case 'open': {
      const document = await host.open(caller, sessionId, input.clientId, input.context, input.openId);
      if (!local) return document;
      local.supply(document, caller);
      // Main supplies the private document directly to the isolated frame.
      return { viewId: document.viewId, transport: 'sandbox',
        prefersBorder: document.prefersBorder } satisfies McpAppSandboxView;
    }
    case 'cancel-open':
      await host.cancelOpen(caller, sessionId, input.openId);
      return {};
    case 'message':
      if (local) throw new Error('MCP_APP_FRAME_REQUIRED');
      await host.dispatch(caller, sessionId, input.viewId, input.message);
      return {};
    case 'poll':
      if (local) throw new Error('MCP_APP_FRAME_REQUIRED');
      return await host.poll(caller, sessionId, input.viewId, input.after);
    case 'context':
      host.context(caller, sessionId, input.viewId, input.context);
      return {};
    case 'teardown':
      await host.teardown(caller, sessionId, input.viewId, input.alreadyNotified);
      return {};
    case 'display-mode':
      host.displayMode(caller, sessionId, input.viewId, input.mode);
      return {};
    case 'authorize-link':
      if (local) throw new Error('MCP_APP_FRAME_REQUIRED');
      return await host.authorizeLink(caller, sessionId, input.viewId, input.linkId);
    case 'link-result':
      if (local) throw new Error('MCP_APP_FRAME_REQUIRED');
      host.linkResult(caller, sessionId, input.viewId, input.linkId, input.success);
      return {};
    case 'mount-remote':
    case 'unmount-remote':
    case 'open-link':
      if (local) throw new Error('MCP_APP_FRAME_REQUIRED');
      break;
  }
  throw new Error('MCP_APP_INVALID_REQUEST');
}
