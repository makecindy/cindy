import { Directory, File, Paths } from "expo-file-system";
import { getRandomBytes } from "expo-crypto";
import type { PluginPageFetchResult } from "@cindy/device-link";

/** One viewer owns one temporary file. Bytes still pass the execution computer's plugin ledger. */
export async function readPluginMediaFile(
  path: string,
  kind: "image" | "video",
  read: (path: string, offset: number) => Promise<PluginPageFetchResult>,
  signal: AbortSignal,
) {
  if (!/^\/media\/[a-f0-9]{64}\.[a-z0-9]+$/.test(path))
    throw new Error("PLUGIN_MEDIA_INVALID");
  const token = Array.from(getRandomBytes(24), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const directory = new Directory(Paths.cache, "plugin-media", token);
  directory.create({ intermediates: true });
  const file = new File(directory, path.split("/").pop()!);
  const close = () => {
    if (directory.exists) directory.delete();
  };
  const check = () => {
    if (signal.aborted) throw new Error("PLUGIN_MEDIA_CLOSED");
  };
  let handle: ReturnType<File["open"]> | undefined,
    completed = false;
  let offset = 0,
    mime = "";
  try {
    file.create();
    handle = file.open();
    for (;;) {
      check();
      const response = await read(path, offset);
      check();
      if (
        response.status !== 200 ||
        !response.mime.startsWith(`${kind}/`) ||
        (mime && mime !== response.mime)
      )
        throw new Error("PLUGIN_MEDIA_INVALID");
      mime = response.mime;
      const bytes = Uint8Array.from(atob(response.base64), (char) =>
        char.charCodeAt(0),
      );
      if (offset + bytes.length > 256 * 1024 * 1024)
        throw new Error("PLUGIN_MEDIA_TOO_LARGE");
      handle.writeBytes(bytes);
      if (response.nextOffset === undefined) break;
      if (!bytes.length || response.nextOffset !== offset + bytes.length)
        throw new Error("PLUGIN_MEDIA_INVALID");
      offset = response.nextOffset;
    }
    completed = true;
    return { uri: file.uri, mime, close };
  } finally {
    try {
      handle?.close();
    } finally {
      if (!completed) close();
    }
  }
}
