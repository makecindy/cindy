import {
  CLIPBOARD_CHUNK_CHARS,
  CLIPBOARD_MAX_CHARS,
  parseClipboardContent,
} from "./remoteClipboard.js";
import type { RemoteDesktopRequest } from "./remoteDesktop.js";
import { clipboardSyncErrorCode } from "./clipboardSyncFailure.js";

function skippableContent(error: unknown): boolean {
  return [
    "CLIPBOARD_EMPTY",
    "CLIPBOARD_UNSUPPORTED",
    "CLIPBOARD_TOO_LONG",
  ].includes(clipboardSyncErrorCode(error));
}

export interface LocalClipboardReadCache {
  version?: string;
  digest?: string;
}
export interface ClipboardSyncDeps {
  digest(json: string): string;
  lease: string;
  request<T>(message: RemoteDesktopRequest): Promise<T>;
  localVersion(): Promise<string>;
  readLocal(): Promise<string>;
  writeLocal(json: string, version: string): Promise<string>;
  current(): boolean;
  inline?: boolean;
  localReadCache?: LocalClipboardReadCache;
  /** Diagnostic codes only, never clipboard contents. */
  trace?(stage: string, code?: string): void;
}
export interface ClipboardSyncBaseline {
  local: string;
  remote: string;
  localDigest?: string;
  remoteDigest?: string;
}

/** Serial sync: counter changes trigger reads; content changes trigger writes. */
export class ClipboardSync {
  private pending = false;
  constructor(
    private readonly deps: ClipboardSyncDeps,
    private readonly baseline: ClipboardSyncBaseline = {
      local: "",
      remote: "",
    },
  ) {}
  private check() {
    if (!this.deps.current()) throw new Error("DESKTOP_LEASE_EXPIRED");
  }
  private conflict(local: string, remote: string): never {
    // Preserve counters so idle polls cannot pick a winner. Both adapters must
    // allow the next explicit copy, even when it repeats the conflicting content.
    Object.assign(this.baseline, {
      local,
      remote,
      localDigest: undefined,
      remoteDigest: undefined,
    });
    throw new Error("CLIPBOARD_CONFLICT");
  }
  private async remoteVersion() {
    const { version } = await this.deps.request<{ version: string }>({
      op: "clipboardVersion",
      lease: this.deps.lease,
    });
    this.check();
    if (typeof version !== "string" || !/^\d{1,128}$/.test(version))
      throw new Error("CLIPBOARD_UNSUPPORTED");
    return version;
  }
  private async readLocal(version: string) {
    this.deps.trace?.("phone-read-start");
    const json = await this.deps.readLocal();
    this.check();
    const digest = this.deps.digest(json);
    if ((await this.deps.localVersion()) !== version)
      throw new Error("CLIPBOARD_CHANGED");
    this.check();
    this.rememberLocal(version, digest);
    this.deps.trace?.("phone-read-complete");
    return { json, digest };
  }
  private rememberLocal(version: string, digest: string | undefined) {
    if (this.deps.localReadCache)
      Object.assign(this.deps.localReadCache, { version, digest });
  }
  private async cancel(id: string) {
    await this.deps
      .request({
        op: "clipboardContent",
        lease: this.deps.lease,
        sync: true,
        action: "cancel",
        id,
      })
      .catch(() => {});
  }
  private async readRemote(version: string) {
    const { lease, request } = this.deps;
    let id: string | undefined;
    try {
      this.deps.trace?.("computer-read-start");
      const result = await request<{
        id?: string;
        length: number;
        data?: string;
      }>({
        op: "clipboardContent",
        lease,
        sync: true,
        version,
        action: "copy",
        ...(this.deps.inline ? { inline: true } : {}),
      });
      this.check();
      if (
        !Number.isSafeInteger(result.length) ||
        result.length <= 0 ||
        result.length > CLIPBOARD_MAX_CHARS
      )
        throw new Error("CLIPBOARD_TOO_LONG");
      let json = "";
      if (this.deps.inline && typeof result.data === "string") {
        if (
          result.data.length > CLIPBOARD_CHUNK_CHARS ||
          result.data.length !== result.length
        )
          throw new Error("CLIPBOARD_UNSUPPORTED");
        json = result.data;
      } else {
        if (typeof result.id !== "string" || !result.id)
          throw new Error("CLIPBOARD_UNSUPPORTED");
        id = result.id;
        while (json.length < result.length) {
          this.check();
          const part = await request<{ data: string }>({
            op: "clipboardContent",
            lease,
            sync: true,
            action: "read",
            id,
            offset: json.length,
          });
          this.check();
          if (
            typeof part.data !== "string" ||
            !part.data.length ||
            part.data.length > CLIPBOARD_CHUNK_CHARS ||
            json.length + part.data.length > result.length
          )
            throw new Error("CLIPBOARD_UNSUPPORTED");
          json += part.data;
        }
      }
      const digest = this.deps.digest(json);
      if ((await this.remoteVersion()) !== version)
        throw new Error("CLIPBOARD_CHANGED");
      return { json, digest };
    } finally {
      if (id) void this.cancel(id);
    }
  }
  private async writeRemote(json: string, local: string, remote: string) {
    const { lease, request } = this.deps;
    let id: string | undefined;
    try {
      this.check();
      let committed: { version: string };
      if (this.deps.inline && json.length <= CLIPBOARD_CHUNK_CHARS) {
        if ((await this.deps.localVersion()) !== local)
          throw new Error("CLIPBOARD_CHANGED");
        this.check();
        committed = await request({
          op: "clipboardContent",
          lease,
          sync: true,
          version: remote,
          action: "paste",
          data: json,
        });
      } else {
        const result = await request<{ id: string }>({
          op: "clipboardContent",
          lease,
          sync: true,
          version: remote,
          action: "begin",
          length: json.length,
        });
        id = result.id;
        for (
          let offset = 0;
          offset < json.length;
          offset += CLIPBOARD_CHUNK_CHARS
        ) {
          this.check();
          await request({
            op: "clipboardContent",
            lease,
            sync: true,
            action: "write",
            id,
            offset,
            data: json.slice(offset, offset + CLIPBOARD_CHUNK_CHARS),
          });
        }
        if ((await this.deps.localVersion()) !== local)
          throw new Error("CLIPBOARD_CHANGED");
        this.check();
        committed = await request({
          op: "clipboardContent",
          lease,
          sync: true,
          action: "commit",
          id,
        });
      }
      this.check();
      if (
        typeof committed.version !== "string" ||
        !/^\d{1,128}$/.test(committed.version)
      )
        throw new Error("CLIPBOARD_UNSUPPORTED");
      return committed.version;
    } finally {
      if (id) void this.cancel(id);
    }
  }
  async tick(): Promise<void> {
    if (this.pending) return;
    this.pending = true;
    let local: string | undefined;
    let remote: string | undefined;
    let readLocalDigest: string | undefined;
    let readRemoteDigest: string | undefined;
    const readErrors: { local?: string; remote?: string } = {};
    let cleared = false;
    try {
      this.check();
      local = await this.deps.localVersion();
      this.check();
      remote = await this.remoteVersion();
      if (!this.baseline.local) {
        let digest: string | undefined;
        const cache = this.deps.localReadCache;
        if (cache?.version === local) {
          digest = cache.digest;
        } else {
          // Keep the proven initial native permission read. Reuse it only while
          // the phone pasteboard version remains exactly the same.
          try {
            digest = (await this.readLocal(local)).digest;
          } catch (error) {
            if (!skippableContent(error)) throw error;
            // Connecting only establishes a baseline; no transfer was skipped.
            if ((await this.deps.localVersion()) !== local)
              throw new Error("CLIPBOARD_CHANGED");
          }
        }
        // Establish both content baselines without writing either clipboard.
        // Counter-only rewrites must not import contents predating opt-in.
        let remoteDigest: string | undefined;
        try {
          remoteDigest = (await this.readRemote(remote)).digest;
        } catch (error) {
          if (!skippableContent(error)) throw error;
          // Existing unsupported/empty content is normal when connecting.
          if ((await this.remoteVersion()) !== remote)
            throw new Error("CLIPBOARD_CHANGED");
        }
        if ((await this.deps.localVersion()) !== local)
          throw new Error("CLIPBOARD_CHANGED");
        this.check();
        this.rememberLocal(local, digest);
        Object.assign(this.baseline, {
          local,
          remote,
          localDigest: digest,
          remoteDigest,
        });
        return;
      }
      let localChanged = local !== this.baseline.local;
      let remoteChanged = remote !== this.baseline.remote;
      if (!localChanged && !remoteChanged) return;
      // Read both changed peers even when one is unsupported. Only a proven
      // non-empty change can compete with the other side's copy.
      const skipped =
        (side: "local" | "remote") =>
        (error: unknown): undefined => {
          if (!skippableContent(error)) throw error;
          readErrors[side] = clipboardSyncErrorCode(error);
          return undefined;
        };
      const localContent = localChanged
        ? await this.readLocal(local)
            .catch(skipped("local"))
            .then((content) => {
              if (!content) return undefined;
              readLocalDigest = content.digest;
              return content;
            })
        : undefined;
      const remoteContent = remoteChanged
        ? await this.readRemote(remote)
            .catch(skipped("remote"))
            .then((content) => {
              if (!content) return undefined;
              readRemoteDigest = content.digest;
              return content;
            })
        : undefined;
      this.check();
      if ((await this.deps.localVersion()) !== local)
        throw new Error("CLIPBOARD_CHANGED");
      if (
        remoteChanged &&
        !remoteContent &&
        (await this.remoteVersion()) !== remote
      )
        throw new Error("CLIPBOARD_CHANGED");
      this.check();
      // A validated clear breaks content deduplication for both peers: the
      // next version change may explicitly copy the same content back. Keep
      // counters so clearing alone (or an idle poll) never initiates a write.
      cleared = Object.values(readErrors).includes("CLIPBOARD_EMPTY");
      const skippedCode = [readErrors.local, readErrors.remote].find(
        (code) => code && code !== "CLIPBOARD_EMPTY",
      );
      if (skippedCode) throw new Error(skippedCode);
      // Empty is not a copy to propagate or a competing edit. A real copy on
      // the other side may still sync; never erase it with an empty clipboard.
      const localDigest = localChanged
        ? localContent?.digest
        : this.baseline.localDigest;
      const remoteDigest = remoteChanged
        ? remoteContent?.digest
        : this.baseline.remoteDigest;
      if (localChanged && !localContent) localChanged = false;
      if (remoteChanged && !remoteContent) remoteChanged = false;
      if (
        !cleared &&
        localContent &&
        localContent.digest === this.baseline.localDigest
      )
        localChanged = false;
      if (
        !cleared &&
        remoteContent &&
        remoteContent.digest === this.baseline.remoteDigest
      )
        remoteChanged = false;
      if (localDigest && localDigest === remoteDigest) {
        localChanged = false;
        remoteChanged = false;
      }
      if (localChanged && remoteChanged) this.conflict(local, remote);
      if (localChanged && localContent) {
        const version = await this.writeRemote(
          localContent.json,
          local,
          remote,
        );
        // Native clipboards may normalize or drop portable representations.
        // Record the destination's actual, version-checked content, not its input.
        const actual = await this.readRemote(version);
        Object.assign(this.baseline, {
          local,
          remote: version,
          localDigest: localContent.digest,
          remoteDigest: actual.digest,
        });
        this.deps.trace?.("phone-to-computer-complete");
      } else if (remoteChanged && remoteContent) {
        const written = await this.deps.writeLocal(remoteContent.json, local);
        this.check();
        const actual = await this.readLocal(written);
        Object.assign(this.baseline, {
          local: written,
          remote,
          localDigest: actual.digest,
          remoteDigest: remoteContent.digest,
        });
        this.deps.trace?.("computer-to-phone-complete");
      } else {
        Object.assign(this.baseline, {
          local,
          remote,
          localDigest: cleared ? undefined : localDigest,
          remoteDigest: cleared ? undefined : remoteDigest,
        });
        this.deps.trace?.("unchanged-content");
      }
    } catch (error) {
      // Skip this snapshot, not the user's setting. Read again only after a
      // new copy; do not hammer iOS with repeated reads of an unreadable item.
      if (
        local !== undefined &&
        remote !== undefined &&
        skippableContent(error)
      ) {
        this.check();
        const bothChanged =
          local !== this.baseline.local &&
          remote !== this.baseline.remote &&
          !cleared;
        Object.assign(this.baseline, {
          local,
          remote,
          // Unsupported content alone preserves the other peer's evidence;
          // a validated clear invalidates deduplication for both peers.
          localDigest: cleared
            ? undefined
            : local === this.baseline.local
              ? this.baseline.localDigest
              : readLocalDigest,
          remoteDigest: cleared
            ? undefined
            : remote === this.baseline.remote
              ? this.baseline.remoteDigest
              : readRemoteDigest,
        });
        const code = clipboardSyncErrorCode(error);
        this.deps.trace?.(
          code === "CLIPBOARD_EMPTY" ? "content-empty" : "content-skipped",
          code,
        );
        // Both peers changed and one of them is unreadable: as with any
        // simultaneous change, both copies are kept, but the user is told so
        // instead of the readable copy silently never arriving.
        if (bothChanged && code !== "CLIPBOARD_EMPTY")
          this.conflict(local, remote);
        return;
      }
      throw error;
    } finally {
      this.pending = false;
    }
  }
}
