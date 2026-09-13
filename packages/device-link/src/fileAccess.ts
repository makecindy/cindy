/** Shared file read policy. UI entry points never choose a transport. */
export const FILE_INLINE_MAX_BYTES = 64 * 1024;

export interface DeviceFileResult {
  ossKey: string;
  size: number;
  mimeType: string;
  inlineBase64?: string;
  /** Only emitted when the caller explicitly requests preparation. */
  transferRequired?: boolean;
}

export function assertFileReadActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("FILE_PEER_CANCELLED");
}

/** Old hosts ignore prepareOnly and return their ordinary OSS/inline response. */
export async function readDeviceFile<T extends DeviceFileResult>(options: {
  prepare(): Promise<DeviceFileResult>;
  peer(metadata: DeviceFileResult): Promise<T | null>;
  fallback(): Promise<DeviceFileResult>;
  /** Retained preview/playback URL, rather than an immediate complete-file copy. */
  stream?: boolean;
  /** Adapter returns expiring staging URLs without copying them into consumer-owned storage. */
  peerResultIsTransient?: boolean;
  signal?: AbortSignal;
  isCurrent?(): boolean;
  discard?(result: DeviceFileResult | T): Promise<void> | void;
}): Promise<DeviceFileResult | T> {
  const active = () =>
    !options.signal?.aborted && options.isCurrent?.() !== false;
  const assertActive = () => {
    if (!active()) throw new Error("FILE_PEER_CANCELLED");
  };
  const discardCancelled = async (result: DeviceFileResult | T): Promise<never> => {
    try {
      await options.discard?.(result);
    } finally {
      throw new Error("FILE_PEER_CANCELLED");
    }
  };
  assertActive();
  const prepared = await options.prepare();
  if (!active()) return discardCancelled(prepared);
  if (prepared.transferRequired !== true) return prepared;
  const needsFallback = options.stream &&
    (options.peerResultIsTransient || /^(audio|video)\//i.test(prepared.mimeType));
  const direct = needsFallback ? null : await options.peer(prepared);
  if (direct && !active()) return discardCancelled(direct);
  else assertActive();
  if (direct) return direct;
  const result = await options.fallback();
  if (!active()) return discardCancelled(result);
  return result;
}

/** Directory and bounded text previews retain the existing host-side semantics. */
export function createDeviceFileOperations(
  invoke: <T>(args: Record<string, unknown>) => Promise<T>,
) {
  return {
    listDir: <T>(args: Record<string, unknown>) =>
      invoke<T>({ ...args, op: "listDir" }),
    readFile: <T>(args: Record<string, unknown>) =>
      invoke<T>({ ...args, op: "readFile" }),
  };
}

/** Large OSS uploads outlive a single relay invocation; keep their existing job protocol. */
export async function exportDeviceFile(
  invoke: <T>(args: Record<string, unknown>) => Promise<T>,
  workdir: string,
  relPath: string,
  signal?: AbortSignal,
): Promise<DeviceFileResult> {
  assertFileReadActive(signal);
  const start = await invoke<{
    ok: boolean;
    transferId: string;
    size: number;
    message?: string;
  }>({ op: "exportFileStart", workdir, relPath });
  assertFileReadActive(signal);
  if (!start.ok) throw new Error(start.message ?? "FILE_EXPORT_FAILED");
  const deadline = Date.now() + 30 * 60_000;
  for (;;) {
    assertFileReadActive(signal);
    const status = await invoke<{
      ok: boolean;
      state: string;
      key?: string;
      message?: string;
    }>({ op: "exportFileStatus", workdir, transferId: start.transferId });
    assertFileReadActive(signal);
    if (!status.ok || status.state === "error")
      throw new Error(status.message ?? "FILE_EXPORT_FAILED");
    if (status.state === "done" && status.key)
      return {
        ossKey: status.key,
        size: start.size,
        mimeType: "application/octet-stream",
      };
    if (Date.now() > deadline) throw new Error("FILE_EXPORT_TIMEOUT");
    await new Promise<void>((resolve) => setTimeout(resolve, 700));
  }
}
