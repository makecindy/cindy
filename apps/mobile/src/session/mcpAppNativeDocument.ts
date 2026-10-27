import { Directory, File, Paths } from "expo-file-system";
import { getRandomBytes } from "expo-crypto";
import {
  mcpAppSandboxDocument,
  type McpAppDocument,
} from "@cindy/maker-shared/mcp-apps";
import native from "../../modules/cindy-html-preview/src/CindyHtmlPreviewModule";

export interface McpAppNativeDocument {
  source: { uri: string };
  resourceUrl: string;
  documentUrls: readonly string[];
  close(): Promise<void>;
}
let swept = false;

// Android's WebStorage.deleteOrigin does not clear localStorage and has no
// completion callback. Run in the new App origin, before any untrusted HTML,
// and do not navigate to that HTML until IndexedDB deletion has completed.
export const MCP_APP_STORAGE_BOOTSTRAP = `<!doctype html><meta charset="utf-8"><script>
(async()=>{
  localStorage.clear();
  sessionStorage.clear();
  const databases=await indexedDB.databases();
  await Promise.all(databases.map(({name})=>new Promise((resolve,reject)=>{
    if(typeof name!=='string'){resolve();return;}
    const request=indexedDB.deleteDatabase(name);
    request.onsuccess=()=>resolve();
    request.onerror=request.onblocked=()=>reject(new Error('MCP_APP_STORAGE_RESET_FAILED'));
  })));
  location.replace('/resource.html');
})().catch(()=>{});
</script>`;

/** Reuse the installed loopback server; different ports give proxy and App distinct origins. */
export async function prepareMcpAppNativeDocument(
  document: McpAppDocument,
  bridgeKey: string,
): Promise<McpAppNativeDocument> {
  if (!native?.appHostAvailable || !native.startApp) throw new Error("MCP_APP_NATIVE_UPDATE_REQUIRED");
  const server = native;
  const start = native.startApp.bind(native);
  if (!swept) {
    swept = true;
    const parent = new Directory(Paths.cache, "mcp-apps");
    if (parent.exists) {
      for (const child of parent.list()) {
        if (child instanceof Directory && /^[a-f0-9]{48}$/.test(child.name)) {
          try {
            child.delete();
          } catch {
            /* OS cache eviction remains the fallback. */
          }
        }
      }
    }
  }
  const token = () =>
    Array.from(getRandomBytes(24), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  const resourceToken = token();
  const proxyToken = token();
  const directory = new Directory(Paths.cache, "mcp-apps", resourceToken);
  directory.create({ intermediates: true });
  const root = decodeURIComponent(directory.uri.slice("file://".length));
  const started: string[] = [];
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      try {
        const stopped = await Promise.allSettled(
          started.map((value) => server.stop(value)),
        );
        const failed = stopped.find((result) => result.status === "rejected");
        if (failed?.status === "rejected") throw failed.reason;
      } finally {
        if (directory.exists) directory.delete();
      }
    })());
  try {
    const resource = new File(directory, "0");
    resource.create();
    resource.write(document.html);
    const bootstrap = new File(directory, "2");
    bootstrap.create();
    bootstrap.write(MCP_APP_STORAGE_BOOTSTRAP);
    started.push(resourceToken);
    const resourceUrl = await start(
      root,
      "initialize.html",
      resourceToken,
      document.csp,
      [["initialize.html", "2", "text/html"], ["resource.html", "0", "text/html"]],
    );
    const resourceOrigin = new URL(resourceUrl).origin;
    const proxy = new File(directory, "1");
    proxy.create();
    proxy.write(mcpAppSandboxDocument(bridgeKey, resourceUrl));
    const csp = `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src ${resourceOrigin}; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`;
    started.push(proxyToken);
    const proxyUrl = await start(root, "proxy.html", proxyToken, csp, [
      ["proxy.html", "1", "text/html"],
    ]);
    if (new URL(proxyUrl).origin === resourceOrigin)
      throw new Error("MCP_APP_INVALID_ORIGIN");
    return {
      source: { uri: proxyUrl },
      resourceUrl,
      // Each server bootstraps its HttpOnly cookie then redirects to its one manifest entry.
      documentUrls: [
        proxyUrl,
        new URL("/proxy.html", proxyUrl).href,
        resourceUrl,
        new URL("/initialize.html", resourceUrl).href,
        new URL("/resource.html", resourceUrl).href,
      ],
      close,
    };
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
}
