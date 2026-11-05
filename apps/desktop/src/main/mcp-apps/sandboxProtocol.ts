import { withHostAppSdk, withHostPageRuntime } from '@cindy/maker-shared/mcp-app-sdk';
import { isSafeGhostRelativePath } from '@cindy/plugin-protocol';
import { app, protocol, session, type WebContents, type WebFrameMain } from 'electron';
import { randomUUID } from 'node:crypto';
import { getCurrentDbClientSnapshot } from '../localDb/client/current.js';
import { appCsp, MCP_APPS_MAX_BYTES } from './protocol.js';
import {
  mcpAppSandboxDocument,
  mcpAppFrameUrlAllowed,
  HOST_APP_SDK_PATH,
  type McpAppDocument,
} from '../../shared/mcpApps.js';
import { mcpAppDirectSandboxDocument } from './sandboxBridge.js';

export const mcpAppSchemePrivilege = {
  scheme: 'cindy-mcp-app',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
};
const frameHeader = 'X-Cindy-Mcp-App-Frame';
let fileReader: ((id: string, token: string, request: Request) => Promise<Response>) | undefined;
export function setMcpAppFileReader(read: typeof fileReader): void { fileReader = read; }
let callerCleanup: ((caller: string) => Promise<void>) | undefined;
export function setMcpAppCallerCleanup(cleanup?: (caller: string) => Promise<void>): void {
  callerCleanup = cleanup;
}
const documents = new Map<
  string,
  {
    html: string; fileKey: string; document: McpAppDocument; owner: object | null; caller?: string;
    dispose?: () => void;
    nativeAssets?: (relativePath: string) => Promise<Response>;
    bridge?: { key: string; frame?: WebFrameMain; invoke(input: unknown): Promise<unknown> };
  }
>();
// Electron throws this from any WebFrameMain getter (`contents.focusedFrame`, `frame.url`,
// `frame.parent`, `event.frame`) once the render frame is gone, which is routine while an
// App iframe is being torn down or recreated. It must not escape a WebContents event
// callback: that surfaces as a top-level uncaughtException and quits the whole app.
function isDisposedFrameError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('Render frame was disposed');
}
async function readBridgeBody(request: Request): Promise<string> {
  const reader = request.body?.getReader();
  if (!reader) throw new Error('MCP_APP_INVALID_REQUEST');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MCP_APPS_MAX_BYTES) {
        await reader.cancel();
        throw new Error('MCP_APP_MESSAGE_TOO_LARGE');
      }
      chunks.push(value);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } finally { reader.releaseLock(); }
}
export function supplyMcpAppDocument(
  document: McpAppDocument, caller?: string, invoke?: (input: unknown) => Promise<unknown>,
  dispose?: () => void,
): void {
  documents.set(document.viewId, {
    html: withHostAppSdk(document.html, 'cindy-mcp-app://' + document.viewId + '-view' + HOST_APP_SDK_PATH),
    fileKey: randomUUID(), document, owner: getCurrentDbClientSnapshot(), caller, dispose,
    bridge: invoke ? { key: randomUUID(), invoke } : undefined,
  });
}
export function removeMcpAppDocument(id: string): void {
  const entry = documents.get(id);
  documents.delete(id);
  entry?.dispose?.();
}
export function clearMcpAppDocuments(): void {
  for (const id of documents.keys()) removeMcpAppDocument(id);
}
export function mountRemoteAppDocument(
  input: unknown, caller: string, invoke?: (input: unknown) => Promise<unknown>, dispose?: () => void,
): string {
  const document = input as McpAppDocument;
  if (!getCurrentDbClientSnapshot()) throw new Error('MCP_APP_OWNER_UNAVAILABLE');
  if (
    !document ||
    typeof document.html !== 'string' ||
    Buffer.byteLength(document.html) > MCP_APPS_MAX_BYTES
  )
    throw new Error('MCP_APP_INVALID_DOCUMENT');
  if ([...documents.values()].filter((item) => item.caller === caller).length >= 16)
    throw new Error('MCP_APP_VIEW_LIMIT');
  const policy = appCsp({ csp: document.policy });
  const id = randomUUID();
  supplyMcpAppDocument({ ...document, viewId: id, csp: policy.header, policy: policy.csp }, caller, invoke, dispose);
  return id;
}

const nativeUiPageBootstrap = `<script data-cindy-native-ui>
(()=>{
 let next=0;const pending=new Map();
 const call=(op,input)=>new Promise((resolve,reject)=>{
  if(pending.size>=16){reject(new Error('UI_UNAVAILABLE'));return;}
  const id=++next,timer=setTimeout(()=>{pending.delete(id);reject(new Error('UI_UNAVAILABLE'));},15000);
  pending.set(id,{resolve,reject,timer});
  window.parent.postMessage({jsonrpc:'2.0',id,method:'cindy/ui',params:{op,input}},'*');
 });
 window.addEventListener('message',event=>{
  if(event.source!==window.parent||event.data?.jsonrpc!=='2.0')return;
  const item=pending.get(event.data.id);if(!item)return;
  pending.delete(event.data.id);clearTimeout(item.timer);
  if(event.data.error)item.reject(new Error('UI_UNAVAILABLE'));else item.resolve(event.data.result);
 });
 const appearance=async(op,input)=>{const result=await call(op,input);if(result?.ok===true)return result.data;
  throw Object.assign(new Error(result?.error?.message||'Appearance unavailable'),{code:result?.error?.code||'APPEARANCE_UNAVAILABLE'});};
 window.cindy=Object.freeze({ui:Object.freeze({read:()=>call('read'),capabilities:()=>call('capabilities'),
  invoke:input=>call('invoke',input),appearance:Object.freeze({read:()=>appearance('appearance.read'),
   set:(patch,options)=>appearance('appearance.set',{patch,ifRevision:options?.ifRevision}),
   reset:(fields,options)=>appearance('appearance.reset',{fields,ifRevision:options?.ifRevision})}),
  visibility:Object.freeze({read:()=>appearance('visibility.read'),set:patch=>appearance('visibility.set',{patch})})})});
})();
</script>`;

/** Native pages share frame isolation and lifecycle, but do not receive the MCP App SDK. */
export function mountNativeUiPageDocument(
  input: { html: string; entry: string }, caller: string, invoke: (input: unknown) => Promise<unknown>,
  readAsset: (relativePath: string) => Promise<Response>, dispose?: () => void,
): string {
  if (!getCurrentDbClientSnapshot()) throw new Error('MCP_APP_OWNER_UNAVAILABLE');
  if (!input || typeof input.html !== 'string' || Buffer.byteLength(input.html) > MCP_APPS_MAX_BYTES ||
      !isSafeGhostRelativePath(input.entry) || !/\.html$/i.test(input.entry)) throw new Error('MCP_APP_INVALID_DOCUMENT');
  if ([...documents.values()].filter(item => item.caller === caller).length >= 16) throw new Error('MCP_APP_VIEW_LIMIT');
  const id = randomUUID(), policy = appCsp();
  const directory = input.entry.split('/').slice(0, -1).join('/');
  const base = `cindy-mcp-app://${id}-view/__cindy/plugin/${directory ? `${directory}/` : ''}`;
  const document: McpAppDocument = { viewId: id, html: input.html, csp: policy.header, policy: policy.csp, prefersBorder: false };
  documents.set(id, { html: withHostPageRuntime(input.html, `<base href="${base}">${nativeUiPageBootstrap}`),
    fileKey: randomUUID(), document, owner: getCurrentDbClientSnapshot(), caller, dispose,
    bridge: { key: randomUUID(), invoke }, nativeAssets: readAsset });
  return id;
}
export function unmountRemoteAppDocument(id: string, caller: string): void {
  if (documents.get(id)?.caller !== caller) throw new Error('MCP_APP_VIEW_UNAVAILABLE');
  removeMcpAppDocument(id);
}
export function assertMcpAppDocumentCaller(id: string, caller: string): void {
  const entry = documents.get(id);
  if (!entry || entry.owner !== getCurrentDbClientSnapshot() || entry.caller !== caller)
    throw new Error('MCP_APP_VIEW_UNAVAILABLE');
}
export function registerMcpAppProtocol(): void {
  // Only Chromium's actual requesting frame can acquire this Main-only channel key.
  // It never appears in HTML, a renderer IPC response, or a JavaScript Request object.
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ['cindy-mcp-app://*/*'] },
    (details, callback) => {
      const url = new URL(details.url);
      if (url.hostname.endsWith('-view') && (url.pathname.startsWith('/__cindy/files/') || url.pathname.startsWith('/__cindy/plugin/'))) {
        const entry = documents.get(url.hostname.slice(0, -5));
        const frame = details.frame;
        try {
          if (!entry || (url.pathname.startsWith('/__cindy/plugin/') && !entry.nativeAssets) || !frame || entry.owner !== getCurrentDbClientSnapshot() ||
              entry.caller !== `renderer:${details.webContentsId}` ||
              frame.url !== `cindy-mcp-app://${url.hostname}/resource` ||
              !['GET', 'HEAD'].includes(details.method)) { callback({ cancel: true }); return; }
        } catch (error) {
          if (!isDisposedFrameError(error)) throw error;
          callback({ cancel: true }); return;
        }
        const headers = Object.fromEntries(Object.entries(details.requestHeaders)
          .filter(([key]) => key.toLowerCase() !== frameHeader.toLowerCase()));
        callback({ requestHeaders: { ...headers, [frameHeader]: entry.fileKey } }); return;
      }
      if (url.pathname !== '/bridge') { callback({ requestHeaders: details.requestHeaders }); return; }
      const entry = documents.get(url.hostname);
      const frame = details.frame;
      if (details.method !== 'POST' || !entry?.bridge || !frame ||
        entry.owner !== getCurrentDbClientSnapshot() ||
        entry.caller !== `renderer:${details.webContentsId}` ||
        frame.url !== `cindy-mcp-app://${url.hostname}/sandbox` ||
        (entry.bridge.frame && entry.bridge.frame !== frame)) {
        callback({ cancel: true }); return;
      }
      entry.bridge.frame = frame;
      const headers = Object.fromEntries(Object.entries(details.requestHeaders)
        .filter(([key]) => key.toLowerCase() !== frameHeader.toLowerCase()));
      callback({ requestHeaders: { ...headers, [frameHeader]: entry.bridge.key } });
    },
  );
  // The main window shares the default session. Preserve its existing permission
  // behavior, but never grant undeclared capabilities to an App or its descendants.
  session.defaultSession.setPermissionRequestHandler((contents, _permission, callback, details) => {
    callback(!isMcpAppPermissionRequest(contents, details));
  });
  session.defaultSession.setPermissionCheckHandler(
    (contents, permission, origin, details) =>
      // Electron 42 grants ordinary host checks by default, but explicitly denies
      // this legacy clipboard read. Installing a handler must retain that denial.
      permission !== 'deprecated-sync-clipboard-read' &&
      !isMcpAppPermissionRequest(contents, details, origin),
  );
  // CSP does not restrict a frame's own location navigation. Keep the policy-bearing
  // document in place; external navigation goes through standard ui/open-link.
  app.on('web-contents-created', (_event, contents) => {
    // A crashed/reloaded renderer cannot unmount its old documents; reload reuses its caller ID.
    const caller = `renderer:${contents.id}`;
    const releaseCaller = () => {
      for (const [id, entry] of documents) if (entry.caller === caller) removeMcpAppDocument(id);
      void callerCleanup?.(caller).catch(() => {});
    };
    contents.on('destroyed', releaseCaller);
    contents.on('render-process-gone', releaseCaller);
    contents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) releaseCaller();
    });
    // DOM keyboard events do not bubble out of a cross-origin App frame. Deliver
    // Escape to the trusted sandbox, which relays the exit to its own controller.
    contents.on('before-input-event', (event, input) => {
      if (
        input.type !== 'keyDown' ||
        input.key !== 'Escape' ||
        input.isAutoRepeat ||
        input.isComposing ||
        input.control ||
        input.alt ||
        input.meta ||
        input.shift
      )
        return;
      try {
        for (let frame = contents.focusedFrame; frame; frame = frame.parent) {
          if (!frame.url.startsWith('cindy-mcp-app:')) continue;
          const url = new URL(frame.url);
          if (url.pathname !== '/sandbox' || url.hostname.endsWith('-view')) continue;
          const entry = documents.get(url.hostname);
          if (!entry || entry.owner !== getCurrentDbClientSnapshot()) return;
          event.preventDefault();
          void frame
            .executeJavaScript("window.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape'}))")
            .catch(() => {});
          return;
        }
      } catch (error) {
        // The focused frame vanished mid-walk: there is nothing left to relay Escape to.
        if (!isDisposedFrameError(error)) throw error;
      }
    });
    contents.on('will-frame-navigate', (event) => {
      try {
        const source = event.frame?.url || event.initiator?.url || '';
        // A declared nested iframe is allowed to load its approved origin. Only
        // descendants of the actual App resource get this grant, never the App
        // itself or its trusted sandbox proxy.
        let nestedDomains: readonly string[] | undefined;
        for (let ancestor = event.frame?.parent; ancestor; ancestor = ancestor.parent) {
          if (!ancestor.url.startsWith('cindy-mcp-app:')) continue;
          const url = new URL(ancestor.url);
          if (!url.hostname.endsWith('-view') || url.pathname !== '/resource') continue;
          const entry = documents.get(url.hostname.slice(0, -5));
          nestedDomains =
            entry?.owner === getCurrentDbClientSnapshot()
              ? (entry.document.policy?.frameDomains ?? [])
              : [];
          break;
        }
        if (!isMcpAppFrameNavigationAllowed(source, event.url, nestedDomains))
          event.preventDefault();
      } catch (error) {
        if (!isDisposedFrameError(error)) throw error;
        // Source and ancestry can no longer be established, so the navigation policy
        // cannot approve it. Fail closed rather than let it bypass the checks.
        event.preventDefault();
      }
    });
  });
  protocol.handle('cindy-mcp-app', async (request) => {
    const url = new URL(request.url);
    const id = url.hostname.replace(/-view$/, '');
    const entry = documents.get(id);
    const doc = entry?.document;
    if (!doc || entry?.owner !== getCurrentDbClientSnapshot())
      return new Response(null, { status: 404 });
    if (url.hostname === `${id}-view` && url.pathname === HOST_APP_SDK_PATH &&
        request.method === 'GET' && !url.search && !url.hash && doc.sdk) {
      return new Response(doc.sdk.source, { headers: {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      } });
    }
    if (url.hostname === `${id}-view` && url.pathname.startsWith('/__cindy/files/')) {
      if (!fileReader || request.headers.get(frameHeader) !== entry.fileKey || url.search || url.hash)
        return new Response(null, { status: 404 });
      return fileReader(id, url.pathname.slice('/__cindy/files/'.length), request);
    }
    if (url.hostname === `${id}-view` && url.pathname.startsWith('/__cindy/plugin/')) {
      if (!entry.nativeAssets || request.headers.get(frameHeader) !== entry.fileKey ||
          !['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 404 });
      try {
        const relative = decodeURIComponent(url.pathname.slice('/__cindy/plugin/'.length));
        if (!isSafeGhostRelativePath(relative)) return new Response(null, { status: 404 });
        const result = await entry.nativeAssets(relative);
        return documents.get(id) === entry && entry.owner === getCurrentDbClientSnapshot()
          ? result : new Response(null, { status: 404 });
      } catch { return new Response(null, { status: 404 }); }
    }
    if (url.pathname === '/bridge' && url.hostname === id) {
      const bridge = entry.bridge;
      if (request.method !== 'POST' || !bridge ||
        request.headers.get(frameHeader) !== bridge.key ||
        bridge.frame?.url !== `cindy-mcp-app://${id}/sandbox`)
        return new Response(null, { status: 403 });
      try {
        const text = await readBridgeBody(request);
        // The document can be revoked while its body is arriving.
        if (documents.get(id) !== entry || entry.owner !== getCurrentDbClientSnapshot())
          return new Response(null, { status: 403 });
        return Response.json(await bridge.invoke(JSON.parse(text)), { headers: { 'Cache-Control': 'no-store' } });
      } catch {
        return new Response(null, { status: 400 });
      }
    }
    if (request.method !== 'GET') return new Response(null, { status: 404 });
    const isSandbox = url.pathname === '/sandbox';
    if (
      isSandbox
        ? url.hostname !== id
        : url.pathname !== '/resource' || url.hostname !== `${id}-view`
    )
      return new Response(null, { status: 404 });
    const resourceUrl = `cindy-mcp-app://${id}-view/resource`;
    return new Response(isSandbox
      ? entry.bridge
        ? mcpAppDirectSandboxDocument(resourceUrl, `cindy-mcp-app://${id}/bridge`)
        : mcpAppSandboxDocument('', resourceUrl)
      : entry.html, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Security-Policy': isSandbox
          ? `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src cindy-mcp-app://${id}-view; connect-src ${entry.bridge ? "'self'" : "'none'"}; object-src 'none'; base-uri 'none'; form-action 'none'`
          : doc.csp,
        'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), clipboard-write=()',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  });
}
export function isMcpAppPermissionRequest(
  contents: Pick<WebContents, 'mainFrame'> | null,
  details: {
    requestingUrl?: string;
    embeddingOrigin?: string;
    securityOrigin?: string;
    isMainFrame: boolean;
  },
  origin?: string,
): boolean {
  const sources = [origin, details.requestingUrl, details.embeddingOrigin, details.securityOrigin];
  if (sources.some((value) => value?.startsWith('cindy-mcp-app:'))) return true;
  if (!contents && !details.isMainFrame) return true;
  const frames = contents?.mainFrame.framesInSubtree ?? [];
  // Match real frame ancestry as well: a nested frame can itself have an HTTPS
  // origin. Missing subframe identity must not become a permission bypass.
  return frames.some((frame) => {
    if (details.isMainFrame || (details.requestingUrl && frame.url !== details.requestingUrl))
      return false;
    for (let current: typeof frame | null = frame; current; current = current.parent) {
      if (current.url.startsWith('cindy-mcp-app:')) return true;
    }
    return false;
  });
}
export function isMcpAppFrameNavigationAllowed(
  source: string,
  target: string,
  nestedDomains?: readonly string[],
): boolean {
  if (nestedDomains !== undefined) return mcpAppFrameUrlAllowed(target, nestedDomains);
  if (!source.startsWith('cindy-mcp-app:')) return true;
  try {
    const from = new URL(source),
      to = new URL(target);
    if (to.protocol !== 'cindy-mcp-app:') return false;
    if (from.hostname.endsWith('-view'))
      return to.hostname === from.hostname && to.pathname === '/resource';
    return to.hostname === from.hostname + '-view' && to.pathname === '/resource';
  } catch {
    return false;
  }
}
