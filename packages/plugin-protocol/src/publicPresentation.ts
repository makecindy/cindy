import { isValidPluginResourceId } from "./internal/pluginResourceId.js";
import {
  isoDate,
  object,
  PluginProtocolError,
  string,
} from "./internal/parse.js";

/** Anonymous display contract. Deliberately excludes manifests, packages and owner identity. */
export interface PublicPluginPresentation {
  schemaVersion: 1;
  pluginId: string;
  name: string;
  description: string | null;
  author: string | null;
  version: string;
  publishedAt: string;
  /** Current verified raster icon, embedded without a storage URL; absent on older servers. */
  icon?: string | null;
}

export function parsePublicPluginPresentation(
  value: unknown,
): PublicPluginPresentation {
  const row = object(value, "publicPlugin");
  if (row.schemaVersion !== 1 || !isValidPluginResourceId(row.pluginId)) {
    throw new PluginProtocolError("Unsupported public plugin presentation");
  }
  const nullableText = (value: unknown, path: string, max: number) =>
    value === null || value === "" ? null : string(value, path, max);
  const image = typeof row.icon === "string" && row.icon.length <= Math.ceil(512 * 1024 / 3) * 4 + 32
    ? /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/.exec(row.icon) : null;
  const base64 = image?.[2] ?? "";
  const size = base64.length / 4 * 3 - (base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0);
  const icon = image && base64.length % 4 === 0 && size <= 512 * 1024 ? row.icon as string : null;
  return {
    schemaVersion: 1,
    pluginId: row.pluginId,
    name: string(row.name, "name", 256),
    description: nullableText(row.description, "description", 10_000),
    author: nullableText(row.author, "author", 256),
    version: string(row.version, "version", 128),
    publishedAt: isoDate(row.publishedAt, "publishedAt"),
    ...(row.icon === undefined ? {} : { icon }),
  };
}
