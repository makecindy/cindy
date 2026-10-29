import { validFileVersion } from './fileTransferPolicy';

/** Shared file read policy. UI entry points never choose a transport. */
export const FILE_INLINE_MAX_BYTES = 64 * 1024;

export interface DeviceFileResult {
  ossKey: string;
  size: number;
  mimeType: string;
  inlineBase64?: string;
  /** Only emitted when the caller explicitly requests preparation. */
  transferRequired?: boolean;
  /** Opaque source identity, emitted only after current authorization and stat. */
  version?: string;
}

export function assertFileReadActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("FILE_PEER_CANCELLED");
}

/** Old hosts ignore prepareOnly and return their ordinary OSS/inline response. */
export async function readDeviceFile<T extends DeviceFileResult>(options: {
  prepare(): Promise<DeviceFileResult>;
  peer(metadata: DeviceFileResult): Promise<T | null>;
  fallback(): Promise<DeviceFileResult>;
  /** Metadata-only preparation is opt-in; old hosts may still return bytes. */
  inline?(): Promise<DeviceFileResult>;
  /** Recheck the source after two-stage export before retaining a reusable copy. */
  revalidate?(): Promise<DeviceFileResult>;
  /** Small files share the platform's versioned disk store with peer downloads. */
  inlineCache?: {
    read(metadata: DeviceFileResult): Promise<DeviceFileResult | null>;
    store(result: DeviceFileResult): Promise<void>;
  };
  /** Same-owner local bytes may render before the host responds. Explicit refresh omits this. */
  cacheFirst?: {
    read(): Promise<DeviceFileResult | T | null>;
    /** Finish retaining a changed fallback before disposing its temporary result. */
    retain?(result: DeviceFileResult | T): Promise<void>;
  };
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
  if (options.cacheFirst) {
    const cached = await options.cacheFirst.read().catch(() => null);
    if (!active()) return discardCancelled(cached ?? { ossKey: '', size: 0, mimeType: '' });
    if (cached) {
      const { retain } = options.cacheFirst;
      // Revalidation belongs to this read; an obsolete caller cannot suppress a reopen.
      void Promise.resolve().then(async () => {
        assertActive();
        const metadata = await options.prepare();
        if (!active()) return discardCancelled(metadata);
        if (validFileVersion(cached.version) && metadata.version === cached.version && metadata.size === cached.size) {
          if (metadata.ossKey) await options.discard?.(metadata);
          return;
        }
        const fresh = await readDeviceFile({ ...options, cacheFirst: undefined, prepare: async () => metadata });
        try { await retain?.(fresh); }
        finally { await options.discard?.(fresh); }
      }).catch(() => { /* Background failure must not replace an already usable preview. */ });
      return cached;
    }
  }
  let prepared = await options.prepare();
  if (!active()) return discardCancelled(prepared);
  const isMediaStream = (file: DeviceFileResult) => options.stream && /^(audio|video)\//i.test(file.mimeType);
  if (!isMediaStream(prepared) && validFileVersion(prepared.version) && prepared.size <= FILE_INLINE_MAX_BYTES) {
    if (prepared.transferRequired === true && options.inline) {
      const cached = await options.inlineCache?.read(prepared).catch(() => null);
      if (!active()) return discardCancelled(cached ?? prepared);
      if (cached) return cached;
      prepared = await options.inline();
      if (!active()) return discardCancelled(prepared);
    }
    if (typeof prepared.inlineBase64 === 'string') {
      await options.inlineCache?.store(prepared).catch(() => undefined);
      if (!active()) return discardCancelled(prepared);
    }
  }
  const mediaStream = isMediaStream(prepared);
  // Small audio/video files arrive inline too, but playback still needs a retained
  // URL. Reuse the streaming path without re-uploading an old host's OSS result.
  const inlineMediaStream = mediaStream && !prepared.ossKey &&
    typeof prepared.inlineBase64 === "string";
  if (prepared.transferRequired !== true && !inlineMediaStream) return prepared;
  const needsFallback = mediaStream || (options.stream && options.peerResultIsTransient);
  const direct = needsFallback ? null : await options.peer(prepared);
  if (direct && !active()) return discardCancelled(direct);
  else assertActive();
  if (direct) {
    // Older hosts' peer endpoint omits media MIME mappings. Use the authorized
    // metadata only for exactly the same version/size; never infer from a URL.
    // Preserve object identity: adapters attach staging leases through WeakMaps.
    if (direct.mimeType === 'application/octet-stream' && validFileVersion(prepared.version) &&
      direct.version === prepared.version && direct.size === prepared.size &&
      /^(audio|video)\//i.test(prepared.mimeType)) direct.mimeType = prepared.mimeType;
    return direct;
  }
  const result = await options.fallback();
  if (!active()) return discardCancelled(result);
  if (!mediaStream && !result.version && validFileVersion(prepared.version) && options.revalidate) {
    try {
      const after = await options.revalidate();
      assertActive();
      // A result without a version can still be persisted by an outer cache.
      // Reject inconsistent exports here, before any consumer can publish them.
      if (after.version !== prepared.version || after.size !== prepared.size || result.size !== prepared.size)
        throw new Error('FILE_PEER_CHANGED');
      return { ...result, version: prepared.version, mimeType: prepared.mimeType };
    } catch (error) { await options.discard?.(result); throw error; }
  }
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
  /** Host-reported upload bytes; hosts that omit `uploaded` simply report no progress. */
  onProgress?: (uploaded: number, total: number) => void,
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
      uploaded?: number;
    }>({ op: "exportFileStatus", workdir, transferId: start.transferId });
    assertFileReadActive(signal);
    if (!status.ok || status.state === "error")
      throw new Error(status.message ?? "FILE_EXPORT_FAILED");
    if (
      status.state === "uploading" &&
      typeof status.uploaded === "number" &&
      Number.isFinite(status.uploaded) &&
      start.size > 0
    )
      onProgress?.(
        Math.min(Math.max(0, status.uploaded), start.size),
        start.size,
      );
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

/** Serialize work per connection; busy peers should queue, not spill into OSS. */
export function createFileReadQueue() {
  const tails = new Map<string, Promise<void>>();
  return function run<T>(key: string, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    let started = false;
    const previous = tails.get(key) ?? Promise.resolve();
    const result = previous.then(() => {
      assertFileReadActive(signal);
      started = true;
      return operation();
    });
    const tail = result.then(() => {}, () => {});
    tails.set(key, tail);
    void tail.then(() => { if (tails.get(key) === tail) tails.delete(key); });
    if (!signal) return result;
    return new Promise<T>((resolve, reject) => {
      const abort = () => { if (!started) reject(new Error('FILE_PEER_CANCELLED')); };
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
      void result.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
  };
}
