import {
  pluginPreviewQueryTarget,
  PLUGIN_PREVIEW_QUERY_SCRIPT,
} from "./pluginPreviewQueries";
import { Directory, File, Paths } from "expo-file-system";
import { getRandomBytes } from "expo-crypto";
import native from "../../modules/cindy-html-preview/src/CindyHtmlPreviewModule";
import {
  HTML_SNAPSHOT_CSP,
  withSnapshotHtmlCsp,
} from "@/session/htmlPreviewCsp";
import type { MobileHtmlPreview } from "@/session/mobileHtmlPreview";
import { createFileReadQueue } from "@cindy/device-link";
import type { PluginPageFetchResult } from "@cindy/device-link";

/** Reuse the installed native resource server. Remote localhost is fetched by its execution Host. */
export async function preparePluginLocalPreview(
  source: string,
  read: (
    url: string,
    offset: number,
    revision?: string,
  ) => Promise<PluginPageFetchResult>,
  signal: AbortSignal,
): Promise<MobileHtmlPreview> {
  if (!native?.startOnDemand || !native.resolveRequest)
    throw new Error("PLUGIN_PREVIEW_NATIVE_UNAVAILABLE");
  const server = native,
    remote = new URL(source);
  const entry =
    remote.pathname.replace(/^\//, "") +
    (remote.pathname.endsWith("/") ? "index.html" : "");
  const token = Array.from(getRandomBytes(24), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const dir = new Directory(Paths.cache, "html-previews", token);
  dir.create({ intermediates: true });
  let closed = false,
    sequence = 0,
    phoneOrigin = "";
  const pending = new Set<Promise<void>>();
  const queue = createFileReadQueue();
  const check = () => {
    if (closed || signal.aborted) throw new Error("PLUGIN_PREVIEW_CLOSED");
  };
  const listener = server.addListener("resourceRequest", (event) => {
    if (event.token !== token || closed) return;
    const work = queue(
      "preview",
      async () => {
        const destination = new File(dir, String(sequence++));
        let accepted = false;
        try {
          check();
          const relative = event.path;
          if (
            !relative ||
            relative.includes("\\") ||
            relative.includes(":") ||
            relative.split("/").some((part) => !part || part.startsWith("."))
          )
            throw new Error("INVALID_PREVIEW_PATH");
          const url =
            pluginPreviewQueryTarget(relative, remote.origin) ??
            (relative === entry
              ? remote.href
              : new URL("/" + relative, remote.origin).href);
          const chunks: Uint8Array[] = [];
          let offset = 0,
            revision: string | undefined,
            mime = "",
            status = 200,
            size = 0;
          do {
            const response = await read(url, offset, revision);
            check();
            if (
              !response ||
              typeof response.base64 !== "string" ||
              typeof response.revision !== "string"
            )
              throw new Error("INVALID_PREVIEW_RESPONSE");
            if (revision && revision !== response.revision)
              throw new Error("PREVIEW_CHANGED");
            revision = response.revision;
            mime = response.mime;
            status = response.status;
            const bytes = Uint8Array.from(atob(response.base64), (char) =>
              char.charCodeAt(0),
            );
            size += bytes.length;
            if (size > 8 * 1024 * 1024) throw new Error("PREVIEW_TOO_LARGE");
            chunks.push(bytes);
            if (response.nextOffset === undefined) break;
            if (
              response.nextOffset !== offset + bytes.length ||
              bytes.length === 0
            )
              throw new Error("INVALID_PREVIEW_RESPONSE");
            offset = response.nextOffset;
          } while (true);
          const bytes = new Uint8Array(size);
          let at = 0;
          for (const part of chunks) {
            bytes.set(part, at);
            at += part.length;
          }
          destination.create();
          if (/^(text\/|application\/(javascript|json))/.test(mime)) {
            let text = new TextDecoder("utf-8", { fatal: true })
              .decode(bytes)
              .split(remote.origin)
              .join(phoneOrigin);
            if (mime === "text/html")
              text = withSnapshotHtmlCsp(PLUGIN_PREVIEW_QUERY_SCRIPT + text);
            destination.write(text);
          } else destination.write(bytes);
          check();
          accepted = await server.resolveRequest!(
            token,
            event.id,
            destination.name,
            mime,
            status,
          );
        } catch {
          if (!closed)
            await server.resolveRequest!(token, event.id, "", "", 502).catch(
              () => false,
            );
        } finally {
          if (!accepted && destination.exists) destination.delete();
        }
      },
      signal,
    );
    pending.add(work);
    void work.finally(() => pending.delete(work)).catch(() => {});
  });
  const close = async () => {
    if (closed) return;
    closed = true;
    signal.removeEventListener("abort", abort);
    listener.remove();
    try {
      await server.stop(token);
    } finally {
      await Promise.allSettled([...pending]);
      if (dir.exists) dir.delete();
    }
  };
  const abort = () => {
    void close().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    check();
    const url = await server.startOnDemand!(
      decodeURIComponent(dir.uri.replace(/^file:\/\//, "")),
      entry,
      token,
      HTML_SNAPSHOT_CSP,
    );
    phoneOrigin = new URL(url).origin;
    check();
    return { url, documents: [], onDemand: true, close };
  } catch (error) {
    await close();
    throw error;
  }
}
