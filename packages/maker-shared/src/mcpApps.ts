/** Data-only, additive MCP Apps contract shared by Desktop and Mobile. */
export const MCP_APPS_INVOKE = 'maker:mcp-apps:v1';
export const MCP_APP_CARD = 'mcp-app';
export const MCP_APP_LINK_GRANT_MS = 30_000;
/** Public Host-owned display provenance; never a permission or publisher identity. */
export type PluginInstallationSource = {
  kind: 'official' | 'organization' | 'market' | 'third-party' | 'local' | 'unknown';
  namespace?: string;
};
export function parsePluginInstallationSource(value: unknown): PluginInstallationSource {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { kind: 'unknown' };
  const source = value as Record<string, unknown>;
  if (typeof source.kind !== 'string' || !['official', 'organization', 'market', 'third-party', 'local', 'unknown'].includes(source.kind)) return { kind: 'unknown' };
  if (source.kind === 'organization') return typeof source.namespace === 'string' && source.namespace !== 'local' && /^[a-z0-9][a-z0-9-]*$/.test(source.namespace)
    ? { kind: 'organization', namespace: source.namespace } : { kind: 'unknown' };
  return { kind: source.kind as PluginInstallationSource['kind'] };
}
/** Public card provenance contains no organization identifier. This parser is
 * separate from installation-fact validation, where namespace remains required. */
export function parseMcpAppSource(value: unknown): Pick<PluginInstallationSource, 'kind'> {
  if (value && typeof value === 'object' && !Array.isArray(value) &&
      (value as Record<string, unknown>).kind === 'organization') return { kind: 'organization' };
  return { kind: parsePluginInstallationSource(value).kind };
}

/** Accept the early boolean projection and malformed/missing optional names. */
export function parseMcpAppCustomMcp(value: unknown): true | { name: string } | undefined {
  if (value === true) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const name = (value as Record<string, unknown>).name;
  return typeof name === 'string' && name.trim() ? { name } : true;
}

export function isExceptionalPluginSource(source: PluginInstallationSource): boolean {
  return !['official', 'organization', 'market'].includes(source.kind);
}

export function pluginSourceWarningKey(value: unknown): string | undefined {
  const source = parsePluginInstallationSource(value);
  return isExceptionalPluginSource(source) ? `mcpApps.source.${source.kind}` : undefined;
}

export function pluginSourceTooltip(name: string, source: unknown, label: (key: string) => string, page?: string): string {
  const warning = pluginSourceWarningKey(source);
  return (page ? `${page} — ` : '') + name + (warning ? ` · ${label(warning)}` : '');
}

/** An entry identity, not an arbitrary resource or a page-supplied permission. */
export interface PluginUiSource {
  instanceId: string;
  viewId: string;
}
export interface McpAppLinkAuthorization {
  authorized: true;
  validForMs: number;
}
/** Count the whole round trip against the Host's reservation; no clock sync is required. */
export function isMcpAppLinkAuthorizationCurrent(value: unknown, elapsedMs: number): boolean {
  if (!value || typeof value !== 'object') return false;
  const grant = value as Partial<McpAppLinkAuthorization>;
  return grant.authorized === true && typeof grant.validForMs === 'number' &&
    Number.isFinite(grant.validForMs) && grant.validForMs > 0 &&
    grant.validForMs <= MCP_APP_LINK_GRANT_MS && elapsedMs >= 0 && elapsedMs < grant.validForMs;
}
/** Host-to-controller actions never enter the App's standard JSON-RPC transport. */
/** Current Hosts always set generation; absent means a legacy Host without document fencing. */
export type McpAppHostEvent<T> = { generation?: number } & (
  | { seq: number; message: T; openLink?: never }
  | { seq: number; openLink: { id: string; url: string }; message?: never });
export interface McpAppRecord {
  version: 1;
  serverId: string;
  serverRevision: string;
  resourceUri: string;
  connectionId?: string;
  tool: {
    name: string;
    title?: string;
    inputSchema: { type: 'object'; [key: string]: unknown };
    [key: string]: unknown;
  };
  arguments: Record<string, unknown>;
  result?: {
    content: unknown[];
    structuredContent?: Record<string, unknown>;
    _meta?: Record<string, unknown>;
    isError?: boolean;
    [key: string]: unknown;
  };
  cancelled?: string;
}
export { McpAppSdkCache, mcpAppSdkCacheText } from './mcpAppSdkCache.js';

export interface McpAppDocument {
  /** Optional hash reference, only in response to advertised SDK bytes. */
  sdkRef?: string;
  /** Executor-owned SDK bytes for this View; absent on older hosts. Never persisted in cards. */
  sdk?: { source: string; addons?: { 'cindy/view-state'?: { source: string; reactSource: string } } };
  viewId: string;
  transport?: undefined;
  html: string;
  csp: string;
  prefersBorder: boolean;
  policy?: {
    connectDomains?: string[];
    resourceDomains?: string[];
    frameDomains?: string[];
    baseUriDomains?: string[];
  };
}

/** A same-origin module supplied by the execution computer, not the viewing device. */
export const HOST_APP_SDK_PATH = '/__cindy/sdk/ext-apps/app.js';
export const CINDY_VIEW_STATE_SDK_PATH = '/__cindy/sdk/cindy/view-state.js';
export const CINDY_VIEW_STATE_REACT_SDK_PATH = '/__cindy/sdk/cindy/view-state-react.js';
/** Desktop UI metadata only; credential-backed App content stays in Main. */
export interface McpAppSandboxView {
  viewId: string;
  transport: 'sandbox';
  prefersBorder: boolean;
}
export type McpAppOpenResult = McpAppDocument | McpAppSandboxView;
export function parseMcpAppRecord(content: unknown): McpAppRecord | undefined {
  if (!content || typeof content !== 'object') return;
  const value = (content as { mcpApp?: unknown }).mcpApp;
  if (!value || typeof value !== 'object') return;
  const record = value as McpAppRecord;
  return record.version === 1 &&
    typeof record.serverId === 'string' &&
    typeof record.serverRevision === 'string' &&
    typeof record.resourceUri === 'string' &&
    record.resourceUri.startsWith('ui://') &&
    typeof record.tool?.name === 'string' &&
    record.tool.inputSchema?.type === 'object' &&
    record.arguments &&
    typeof record.arguments === 'object' &&
    !Array.isArray(record.arguments) &&
    (!record.result || Array.isArray(record.result.content))
    ? record
    : undefined;
}

/** Read-only history uses public text blocks, never View-only metadata or embedded resources. */
export function mcpAppHistoryText(record: McpAppRecord): string {
  return (record.result?.content ?? [])
    .flatMap((block) => {
      if (!block || typeof block !== 'object') return [];
      const value = block as { type?: unknown; text?: unknown };
      return value.type === 'text' && typeof value.text === 'string' ? [value.text] : [];
    })
    .join('\n\n');
}

/** Public history has no server identity, tool inputs, schema or View-only result. */
export interface McpAppHistory {
  plugin?: { name: string; source?: Pick<PluginInstallationSource, 'kind'> };
  customMcp?: true | { name: string };
  title: string;
  text: string;
}

function parseHistoryPlugin(value: unknown): McpAppHistory['plugin'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const plugin = value as Record<string, unknown>;
  if (typeof plugin.name !== 'string') return;
  return { name: plugin.name, ...(plugin.source !== undefined ? { source: parseMcpAppSource(plugin.source) } : {}) };
}

/** Display persisted records and public summaries without minting a View grant. */
export function parseMcpAppHistory(content: unknown): McpAppHistory | undefined {
  const record = parseMcpAppRecord(content);
  if (record) {
    const plugin = parseHistoryPlugin((record.tool._meta as Record<string, unknown> | undefined)?.['cindy/plugin']);
    const customMcp = parseMcpAppCustomMcp((record.tool._meta as Record<string, unknown> | undefined)?.['cindy/custom-mcp']) ?? true;
    return { title: plugin?.name ?? (customMcp !== true ? customMcp.name : typeof record.tool.title === 'string' ? record.tool.title : record.tool.name),
      text: mcpAppHistoryText(record), ...(plugin ? { plugin } : { customMcp }) };
  }
  if (!content || typeof content !== 'object' || Array.isArray(content)) return;
  const value = (content as { mcpAppHistory?: unknown }).mcpAppHistory;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const summary = value as Record<string, unknown>;
  if (summary.version === 1 && typeof summary.title === 'string' && typeof summary.text === 'string') {
    const plugin = parseHistoryPlugin(summary.plugin);
    const customMcp = parseMcpAppCustomMcp(summary.customMcp);
    return { title: summary.title, text: summary.text,
      ...(plugin ? { plugin } : customMcp ? { customMcp } : {}) };
  }
}

/** Only public history may leave Main outside an authorized sandboxed View. */
export function projectMcpAppContent(content: unknown, marked = false): unknown {
  // Only Main's marker identifies App rows; ordinary structured data may use
  // these property names too and must retain its original content.
  if (!marked) return content;
  let value = content;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { value = undefined; }
  }
  // Unknown/malformed cards must not fall back to sending the private original.
  const history = parseMcpAppHistory(value);
  return { mcpAppHistory: { version: 1, title: history?.title ?? '', text: history?.text ?? '',
    ...(history?.plugin ? { plugin: history.plugin } : {}), ...(history?.customMcp ? { customMcp: history.customMcp } : {}) } };
}

/** Trusted proxy. No privileged host API; relay only the actual inner window. */
export const MCP_APP_SANDBOX_SCRIPT = `
const frame=document.createElement('iframe');
frame.setAttribute('sandbox','allow-scripts allow-forms');
frame.setAttribute('allow',"camera 'none'; microphone 'none'; geolocation 'none'; clipboard-write 'none'");
frame.style.cssText='border:0;width:100%;height:100%;display:block';
let loaded=false;
let resourceOrigin='null';
const post=message=>window.ReactNativeWebView?window.ReactNativeWebView.postMessage(JSON.stringify({key:bridgeKey,message})):window.parent.postMessage(message,'*');
window.addEventListener('keydown',event=>{
 if(event.key==='Escape'&&!event.isComposing&&!event.repeat&&!event.ctrlKey&&!event.altKey&&!event.metaKey&&!event.shiftKey)
  post({jsonrpc:'2.0',method:'ui/notifications/sandbox-escape',params:{}});
});
window.addEventListener('message',event=>{
 const message=event.data;
 if(!message||message.jsonrpc!=='2.0')return;
 if(event.source===frame.contentWindow){
  // WindowProxy identity survives navigation; a replacement document gets no bridge.
  if(!loaded||event.origin!==resourceOrigin)return;
  if(typeof message.method==='string'&&message.method.startsWith('ui/notifications/sandbox-'))return;
  post(message);return;
 }
 if(event.source!==window.parent&&event.source!==window)return;
 if(message.method==='ui/notifications/sandbox-resource-ready'){
  if(loaded)return;
  const resourceUrl=typeof expectedResourceUrl==='string'?expectedResourceUrl:message.params.resourceUrl;
  if(resourceUrl){
   const resource=new URL(resourceUrl),proxy=new URL(window.location.href);
   if(!['http:','https:','cindy-mcp-app:'].includes(resource.protocol)||resource.username||resource.password||
    resource.protocol===proxy.protocol&&resource.host===proxy.host)return;
   // URL.origin can be null for Electron's registered custom scheme.
   resourceOrigin=resource.protocol+'//'+resource.host;
   frame.setAttribute('sandbox','allow-scripts allow-same-origin allow-forms');frame.src=resource.href;
  }
  else{frame.srcdoc=message.params.html;}
  loaded=true;
  document.body.appendChild(frame);return;
 }
 if(loaded)frame.contentWindow?.postMessage(message,resourceOrigin==='null'?'*':resourceOrigin);
});
post({jsonrpc:'2.0',method:'ui/notifications/sandbox-proxy-ready',params:{}});
`;
export function mcpAppSandboxDocument(nativeBridgeKey = '', resourceUrl?: string): string {
  const key = JSON.stringify(nativeBridgeKey).replace(/</g, '\\u003c');
  const resource = JSON.stringify(resourceUrl ?? null).replace(/</g, '\\u003c');
  // The top-level WebView owns the layout viewport; the App iframe cannot set it.
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}</style></head><body><script>const bridgeKey=${key};const expectedResourceUrl=${resource};${MCP_APP_SANDBOX_SCRIPT}</script></body></html>`;
}
/** Legacy inline wrapper; served native Views receive CSP headers from their resource server. */
export function mcpAppNativeResource(html: string, csp: string): string {
  const escaped = csp.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${escaped}">${html}`;
}
/** Native frame navigation needs its own gate; document CSP does not cover location. */
export function mcpAppFrameUrlAllowed(value: string, domains: readonly string[] = []): boolean {
  if (value === 'about:blank' || value === 'about:srcdoc') return true;
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return false;
    return domains.some((domain) => {
      const wildcard = domain.includes('://*.');
      const anyPort = /:\*\/?$/.test(domain);
      const source = new URL(domain.replace('://*.', '://').replace(/:\*(\/?$)/, '$1'));
      return (
        source.protocol === url.protocol &&
        (anyPort || source.port === url.port) &&
        (wildcard ? url.hostname.endsWith('.' + source.hostname) : url.hostname === source.hostname)
      );
    });
  } catch {
    return false;
  }
}
