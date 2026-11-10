import {
  REMOTE_RESOURCE_INVOKE_CHANNEL,
  PLUGIN_COLLECTION,
  PLUGIN_PAGE_PRIMITIVE,
  PLUGIN_PAGE_MAX_BUNDLE_BYTES,
  type PluginPageDocument,
  type PluginPageAsset,
  type RemoteActionInvokeResponse,
} from "@cindy/device-link";
import type { RemoteInvoke } from "@/device-link/mobileMakerTransport";

export async function invokePlugin<T>(
  invoke: RemoteInvoke,
  deviceId: string,
  pluginId: string,
  actionId: string,
  input: Record<string, unknown> = {},
): Promise<T> {
  const reply = await invoke<RemoteActionInvokeResponse>(
    deviceId,
    REMOTE_RESOURCE_INVOKE_CHANNEL,
    [
      {
        client: { protocolVersion: 1, primitives: [PLUGIN_PAGE_PRIMITIVE] },
        collectionId: PLUGIN_COLLECTION,
        resourceRef: {
          collectionId: PLUGIN_COLLECTION,
          kind: "plugin",
          id: pluginId,
        },
        actionId,
        input,
      },
    ],
  );
  return reply.result as T;
}

/** No partial page is mounted. Assets are read from this lease's immutable file list. */
export async function loadPluginPageAssets(
  document: PluginPageDocument,
  read: (path: string, offset: number) => Promise<PluginPageAsset>,
  current: () => boolean,
) {
  if (
    !document ||
    typeof document.pageId !== "string" ||
    !Array.isArray(document.files) ||
    document.files.length > 10_000 ||
    !document.files.some((file) => file.path === document.entry)
  )
    throw new Error("PLUGIN_PAGE_INVALID");
  if (
    document.files.reduce((size, file) => size + file.size, 0) >
    PLUGIN_PAGE_MAX_BUNDLE_BYTES
  )
    throw new Error("PLUGIN_PAGE_BUNDLE_TOO_LARGE");
  const assets: Record<string, PluginPageAsset> = Object.create(null);
  for (let start = 0; start < document.files.length; start += 4) {
    await Promise.all(
      document.files.slice(start, start + 4).map(async (file) => {
        if (
          typeof file.path !== "string" ||
          file.path
            .split("/")
            .some((part) => !part || part === ".." || part === ".") ||
          file.path.includes("\\") ||
          !Number.isSafeInteger(file.size) ||
          file.size < 0
        )
          throw new Error("PLUGIN_ASSET_INVALID");
        const chunks: string[] = [];
        for (let offset = 0; offset < file.size; offset += 48 * 1024) {
          if (!current()) throw new Error("PLUGIN_PAGE_CLOSED");
          const chunk = await read(file.path, offset);
          const expected = Math.min(48 * 1024, file.size - offset);
          if (
            !chunk ||
            chunk.mime !== file.mime ||
            typeof chunk.base64 !== "string" ||
            chunk.base64.length !== 4 * Math.ceil(expected / 3) ||
            !/^[A-Za-z0-9+/]*={0,2}$/.test(chunk.base64)
          )
            throw new Error("PLUGIN_ASSET_INVALID");
          chunks.push(chunk.base64);
        }
        assets[file.path] = { mime: file.mime, base64: chunks.join("") };
      }),
    );
  }
  if (!current()) throw new Error("PLUGIN_PAGE_CLOSED");
  return assets;
}

/** Read-only page recovery. Never retries a page post, fetch write or native answer. */
export function createPluginPagePoller(options: {
  active(): boolean;
  read(current: () => boolean): Promise<void>;
  failed(error: unknown): void;
}) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false, disposed = false, generation = 0, failures = 0;
  let resumed = false;
  const clear = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const run = async () => {
    if (disposed || running || !options.active()) return;
    clear();
    running = true;
    resumed = false;
    const started = generation;
    let again = true;
    try {
      await options.read(() => !disposed && started === generation && options.active());
      if (started === generation && options.active()) failures = 0;
    } catch (error) {
      if (!disposed && started === generation && options.active()) {
        failures++;
        // Expired/revoked pages need an explicit reopen, preserving unsaved page content.
        const message = error instanceof Error ? error.message : String(error);
        again = failures < 3 && !/\[(?:NOT_FOUND|PERMISSION_DENIED|PRECONDITION_FAILED|INVALID_PARAMS)\]/.test(message);
        if (!again) options.failed(error);
      }
    } finally {
      running = false;
      if (!disposed && options.active() && (resumed || (again && started === generation)))
        timer = setTimeout(() => void run(), resumed ? 0 : 1_000 * 2 ** failures);
    }
  };
  return {
    resume() {
      if (disposed) return;
      clear();
      failures = 0;
      if (running) resumed = true;
      else void run();
    },
    pause() { generation++; resumed = false; clear(); },
    dispose() { disposed = true; generation++; clear(); },
  };
}
