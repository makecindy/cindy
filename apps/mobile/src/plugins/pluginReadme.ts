import {
  REMOTE_RESOURCE_INVOKE_CHANNEL,
  PLUGIN_COLLECTION,
  type RemoteActionInvokeResponse,
} from "@cindy/device-link";
import {
  inlineGhostReadmeReferenceImages,
  resolveGhostReadmeAssetPath,
  type GhostReadmeContent,
} from "@cindy/plugin-protocol";
import type { RemoteInvoke } from "@/device-link/mobileMakerTransport";
import { parseMobileMarkdown } from "@/session/messageMarkdown";

/**
 * Plugin detailed introduction (manifest.readme) on the phone: the detail resource only says
 * one exists; the content is fetched from the Host when the page opens. Only package images
 * the Host returned are shown.
 */
/** Same action id as the Host's `PLUGIN_README_ACTION` (mobilePageService). */
export const PLUGIN_README_ACTION = "readme:get";

/** Host reply shape check; anything else is treated as a failed read. */
export function parsePluginReadme(value: unknown): GhostReadmeContent | null {
  if (value === null) return null;
  const raw = value as Partial<GhostReadmeContent> | undefined;
  if (
    !raw ||
    typeof raw !== "object" ||
    typeof raw.path !== "string" ||
    typeof raw.markdown !== "string" ||
    !raw.images ||
    typeof raw.images !== "object" ||
    Array.isArray(raw.images)
  )
    throw new Error("PLUGIN_README_INVALID");
  const images: Record<string, string> = {};
  for (const [path, uri] of Object.entries(raw.images))
    if (typeof uri === "string" && uri.startsWith("data:image/")) images[path] = uri;
  // 手机的 Markdown 解析器只认行内图片：引用式图片先改写成行内，图片查表和渲染用同一份正文。
  return { path: raw.path, markdown: inlineGhostReadmeReferenceImages(raw.markdown), images };
}

/**
 * Image sources keyed by the URLs exactly as the reader sees them. Only package images the
 * Host returned are listed; every other image renders as the reader's text placeholder.
 */
export function pluginReadmeImageSources(
  content: GhostReadmeContent,
): ReadonlyMap<string, { uri: string }> {
  const sources = new Map<string, { uri: string }>();
  const visit = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== "object") return;
    const value = node as Record<string, unknown>;
    if (value.type === "image" && typeof value.url === "string") {
      const path = resolveGhostReadmeAssetPath(content.path, value.url);
      const uri = path ? content.images[path] : undefined;
      if (uri) sources.set(value.url, { uri });
    }
    Object.values(value).forEach(visit);
  };
  visit(parseMobileMarkdown(content.markdown));
  return sources;
}

export async function loadPluginReadme(
  invoke: RemoteInvoke,
  deviceId: string,
  pluginId: string,
  locale: string,
): Promise<GhostReadmeContent | null> {
  const reply = await invoke<RemoteActionInvokeResponse>(
    deviceId,
    REMOTE_RESOURCE_INVOKE_CHANNEL,
    [
      {
        client: { protocolVersion: 1, primitives: [], locale },
        collectionId: PLUGIN_COLLECTION,
        resourceRef: { collectionId: PLUGIN_COLLECTION, kind: "plugin", id: pluginId },
        actionId: PLUGIN_README_ACTION,
        input: {},
      },
    ],
  );
  return parsePluginReadme(reply.result);
}
