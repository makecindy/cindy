import {
  CLIPBOARD_CHUNK_CHARS, CLIPBOARD_MAX_CHARS, parseClipboardContent,
  type RemoteDesktopRequest,
} from "@cindy/device-link";
import { remotePresentation } from "../../modules/cindy-remote-presentation/src";

/** Explicit transfer only. Sequential bounded invokes keep screen traffic responsive. */
export async function transferClipboardContent(
  action: "copy" | "paste",
  lease: string,
  request: <T>(message: RemoteDesktopRequest) => Promise<T>,
  check: () => void,
): Promise<void> {
  if (!remotePresentation?.readClipboard || !remotePresentation.writeClipboard)
    throw new Error("CLIPBOARD_UPGRADE");
  let id: string | undefined;
  try {
    check();
    if (action === "paste") {
      const json = await remotePresentation.readClipboard();
      check();
      parseClipboardContent(json);
      const result = await request<{ id: string }>({ op: "clipboardContent", lease, action: "begin", length: json.length });
      id = result.id;
      for (let offset = 0; offset < json.length; offset += CLIPBOARD_CHUNK_CHARS) {
        check();
        await request({ op: "clipboardContent", lease, action: "write", id, offset, data: json.slice(offset, offset + CLIPBOARD_CHUNK_CHARS) });
      }
      check();
      await request({ op: "clipboardContent", lease, action: "commit", id });
      check();
    } else {
      const result = await request<{ id: string; length: number }>({ op: "clipboardContent", lease, action: "copy" });
      id = result.id;
      if (!Number.isSafeInteger(result.length) || result.length <= 0 || result.length > CLIPBOARD_MAX_CHARS)
        throw new Error("CLIPBOARD_TOO_LONG");
      let json = "";
      while (json.length < result.length) {
        check();
        const { data } = await request<{ data: string }>({ op: "clipboardContent", lease, action: "read", id, offset: json.length });
        if (typeof data !== "string" || !data.length || data.length > CLIPBOARD_CHUNK_CHARS || json.length + data.length > result.length)
          throw new Error("CLIPBOARD_UNSUPPORTED");
        json += data;
      }
      check();
      parseClipboardContent(json);
      await remotePresentation.writeClipboard(json);
      check();
    }
  } finally {
    // Best-effort disposal only; never retry a paste after an uncertain response.
    if (id) void request({ op: "clipboardContent", lease, action: "cancel", id }).catch(() => {});
  }
}
