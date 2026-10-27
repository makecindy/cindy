import { Buffer } from 'node:buffer';
import type { ReadResourceResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { McpUiResourceMetaSchema } from '@modelcontextprotocol/ext-apps/app-bridge';
import type { McpUiResourceMeta } from '@modelcontextprotocol/ext-apps';
import type { McpAppRecord } from '../../shared/mcpApps.js';

export const MCP_APPS_EXTENSION = 'io.modelcontextprotocol/ui';
export const MCP_APPS_MAX_BYTES = 4 * 1024 * 1024;
// Bound serialized remote results, reserving space for invoke and routing metadata.
export const MCP_APPS_MAX_REMOTE_BYTES = MCP_APPS_MAX_BYTES - 64 * 1024;
// Leave room for JSON-escaped history rows, initialization and input/result envelopes.
export const MCP_APPS_MAX_CARD_BYTES = MCP_APPS_MAX_BYTES / 4;

/** Bound the complete persisted card; never change the result returned to the model. */
export function boundedAppRecord(record: McpAppRecord): McpAppRecord {
  const fits = (value: McpAppRecord) =>
    Buffer.byteLength(JSON.stringify({ mcpApp: value })) <= MCP_APPS_MAX_CARD_BYTES;
  if (fits(record)) return record;
  if (!record.result) throw new Error('MCP_APP_CARD_TOO_LARGE');
  const bounded: McpAppRecord = {
    ...record,
    result: {
      isError: true,
      content: [{ type: 'text', text: 'MCP_APP_RESULT_TOO_LARGE' }],
    },
  };
  // Input or tool metadata can exceed the budget even after removing the result.
  if (!fits(bounded)) throw new Error('MCP_APP_CARD_TOO_LARGE');
  return bounded;
}

export function uiToolUri(tool: Tool): string | undefined {
  const ui = tool._meta?.ui as { resourceUri?: unknown } | undefined;
  const uri = ui?.resourceUri ?? tool._meta?.['ui/resourceUri'];
  return typeof uri === 'string' &&
    uri.startsWith('ui://') &&
    uri.length <= 8192 &&
    !/\s/.test(uri) &&
    Array.from(uri).every((character) => character.charCodeAt(0) >= 32)
    ? uri
    : undefined;
}

export function toolVisibleTo(tool: Tool, audience: 'model' | 'app'): boolean {
  const ui = tool._meta?.ui as { visibility?: unknown } | undefined;
  return (
    ui?.visibility === undefined ||
    (Array.isArray(ui.visibility) && ui.visibility.includes(audience))
  );
}

/** No schemes, directives, quotes, whitespace, credentials or paths from a CSP source. */
export function validateCspDomains(domains: string[] | undefined): string[] {
  if (domains && (!Array.isArray(domains) || domains.length > 100))
    throw new Error('MCP_APP_INVALID_CSP_DOMAIN');
  return (domains ?? []).map((source) => {
    if (
      !/^(https?|wss?):\/\/(?:\*\.)?(?:[a-zA-Z0-9.-]+|\[[a-fA-F0-9:]+\])(?::(?:[0-9]{1,5}|\*))?\/?$/.test(
        source,
      )
    ) {
      throw new Error('MCP_APP_INVALID_CSP_DOMAIN');
    }
    const url = new URL(source.replace('://*.', '://wildcard.').replace(/:\*(\/?)$/, ':443$1'));
    if (!url.hostname || (url.port && Number(url.port) > 65535))
      throw new Error('MCP_APP_INVALID_CSP_DOMAIN');
    return source;
  });
}

export function appCsp(meta: McpUiResourceMeta = {}): {
  header: string;
  csp: NonNullable<McpUiResourceMeta['csp']>;
} {
  const csp = {
    connectDomains: validateCspDomains(meta.csp?.connectDomains),
    resourceDomains: validateCspDomains(meta.csp?.resourceDomains),
    frameDomains: validateCspDomains(meta.csp?.frameDomains),
    baseUriDomains: validateCspDomains(meta.csp?.baseUriDomains),
  };
  const resources = csp.resourceDomains.join(' ');
  const header = [
    "default-src 'none'",
    `script-src 'self' 'unsafe-inline' ${resources}`,
    `style-src 'self' 'unsafe-inline' ${resources}`,
    `img-src 'self' data: ${resources}`,
    `media-src 'self' data: ${resources}`,
    `font-src 'self' ${resources}`,
    `connect-src ${csp.connectDomains.join(' ') || "'none'"}`,
    `frame-src ${csp.frameDomains.join(' ') || "'none'"}`,
    `base-uri ${csp.baseUriDomains.join(' ') || "'self'"}`,
    "object-src 'none'",
    "form-action 'none'",
    "worker-src 'none'",
  ].join('; ');
  return { header, csp };
}

export function readAppResource(
  result: ReadResourceResult,
  uri: string,
  fallbackMeta?: unknown,
): { html: string; meta: McpUiResourceMeta } {
  const item = result.contents.find(
    (content) => content.uri === uri && content.mimeType === RESOURCE_MIME_TYPE,
  );
  if (!item) throw new Error('MCP_APP_RESOURCE_MISSING');
  if (
    'blob' in item &&
    (item.blob.length > Math.ceil(MCP_APPS_MAX_BYTES / 3) * 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(item.blob))
  )
    throw new Error('MCP_APP_INVALID_RESOURCE');
  const html = 'text' in item ? item.text : Buffer.from(item.blob, 'base64').toString('utf8');
  if (Buffer.byteLength(html) > MCP_APPS_MAX_BYTES) throw new Error('MCP_APP_RESOURCE_TOO_LARGE');
  const meta = McpUiResourceMetaSchema.parse(item._meta?.ui ?? fallbackMeta ?? {});
  // Validate before any document is supplied to a renderer.
  appCsp(meta);
  return { html, meta };
}

export function safeAppLink(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('MCP_APP_INVALID_LINK');
  }
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    value.length > 8192
  ) {
    throw new Error('MCP_APP_INVALID_LINK');
  }
  return url.href;
}
