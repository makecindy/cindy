import {
  CLIPBOARD_CHUNK_CHARS,
  CLIPBOARD_MAX_CHARS,
  parseClipboardContent,
  type RemoteDesktopRequest,
} from "@cindy/device-link";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { clipboardSyncErrorCode } from "./clipboardSyncFailure";

export interface LocalClipboardReadCache {
  version?: string;
  digest?: string;
}
export interface ClipboardSyncDeps {
  lease: string;
  request<T>(message: RemoteDesktopRequest): Promise<T>;
  localVersion(): Promise<string>;
  readLocal(): Promise<string>;
  writeLocal(json: string, version: string): Promise<string>;
  current(): boolean;
  inline?: boolean;
  localReadCache?: LocalClipboardReadCache;
  trace?(stage: string): void;
}
export interface ClipboardSyncBaseline {
  local: string;
  remote: string;
  localDigest?: string;
  remoteDigest?: string;
}

/** Hash every portable representation, in stable key order. No content is retained. */
export function clipboardDigest(json: string): string {
  const content = parseClipboardContent(json);
  return bytesToHex(
    sha256(
      JSON.stringify([
        content.text,
        content.html,
        content.rtf,
        content.url,
        content.png,
      ]),
    ),
  );
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
    const digest = clipboardDigest(json);
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
      const digest = clipboardDigest(json);
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
            if (
              !String(error instanceof Error ? error.message : error).includes(
                "CLIPBOARD_EMPTY",
              )
            )
              throw error;
            if ((await this.deps.localVersion()) !== local)
              throw new Error("CLIPBOARD_CHANGED");
          }
        }
        this.check();
        this.rememberLocal(local, digest);
        Object.assign(this.baseline, { local, remote, localDigest: digest });
        return;
      }
      let localChanged = local !== this.baseline.local;
      let remoteChanged = remote !== this.baseline.remote;
      if (!localChanged && !remoteChanged) return;
      const localContent = localChanged
        ? await this.readLocal(local)
        : undefined;
      const remoteContent = remoteChanged
        ? await this.readRemote(remote)
        : undefined;
      this.check();
      if ((await this.deps.localVersion()) !== local)
        throw new Error("CLIPBOARD_CHANGED");
      this.check();
      if (localContent && localContent.digest === this.baseline.localDigest)
        localChanged = false;
      if (remoteContent && remoteContent.digest === this.baseline.remoteDigest)
        remoteChanged = false;
      const localDigest = localContent?.digest ?? this.baseline.localDigest;
      const remoteDigest = remoteContent?.digest ?? this.baseline.remoteDigest;
      if (localDigest && localDigest === remoteDigest) {
        localChanged = false;
        remoteChanged = false;
      }
      if (localChanged && remoteChanged) {
        Object.assign(this.baseline, {
          local,
          remote,
          localDigest,
          remoteDigest,
        });
        throw new Error("CLIPBOARD_CONFLICT");
      }
      if (localChanged && localContent) {
        const version = await this.writeRemote(
          localContent.json,
          local,
          remote,
        );
        Object.assign(this.baseline, {
          local,
          remote: version,
          localDigest: localContent.digest,
          remoteDigest: localContent.digest,
        });
        this.deps.trace?.("phone-to-computer-complete");
      } else if (remoteChanged && remoteContent) {
        const written = await this.deps.writeLocal(remoteContent.json, local);
        this.check();
        this.rememberLocal(written, remoteContent.digest);
        Object.assign(this.baseline, {
          local: written,
          remote,
          localDigest: remoteContent.digest,
          remoteDigest: remoteContent.digest,
        });
        this.deps.trace?.("computer-to-phone-complete");
      } else {
        Object.assign(this.baseline, {
          local,
          remote,
          localDigest,
          remoteDigest,
        });
        this.deps.trace?.("unchanged-content");
      }
    } catch (error) {
      // Skip this snapshot, not the user's setting. Read again only after a
      // new copy; do not hammer iOS with repeated reads of an unreadable item.
      if (
        local !== undefined &&
        remote !== undefined &&
        [
          "CLIPBOARD_EMPTY",
          "CLIPBOARD_UNSUPPORTED",
          "CLIPBOARD_TOO_LONG",
        ].includes(clipboardSyncErrorCode(error))
      ) {
        this.check();
        Object.assign(this.baseline, {
          local,
          remote,
          localDigest: undefined,
          remoteDigest: undefined,
        });
        this.deps.trace?.("content-skipped");
        return;
      }
      throw error;
    } finally {
      this.pending = false;
    }
  }
}
