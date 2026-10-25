import type { LedgerDb } from "@cindy/runtime-db/mediaLedger";
import { createHash, randomUUID } from "node:crypto";
import { createPersistedMedia } from "@cindy/app-runtime/persistedMedia";
import { withCrossProcessLock } from "@cindy/remote-agent/crossProcessLock";
import type { NodeDatabase } from "../database.js";
import type { DbLogger } from "@cindy/runtime-db/logging";
import path from "node:path";
import { open, lstat, realpath, stat, readFile } from "node:fs/promises";
import { readBoundedFileNoFollow } from "@cindy/remote-agent/readBoundedFile";
import { GHOST_FETCH_UPLOAD_MAX_BYTES_PER_FILE } from "@cindy/plugin-runtime/shared/ghost";
import * as pluginCards from "@cindy/plugin-runtime/cardStoreDb";
import type { GhostCardRow } from "@cindy/plugin-runtime/cardService";
import {
  sniffMediaMime,
  hasRef,
  removeRefs,
  removeRefById,
  sessionCanRead,
  ghostCanRead,
  getBlobInfo,
} from "@cindy/media-core";
import {
  createIntegrationCache,
  integrationCacheKey,
} from "@cindy/media-core/integration-cache";
import {
  getIntegrationCacheHash,
  touchBlob,
  pinBlob,
} from "@cindy/media-core/ledger";
import { verifiedInboundMediaMime } from "@cindy/media-core/inbound-media-verify";
import type { IMHost } from "@cindy/im";
import {
  taskImageRoots,
  readTaskImage,
  type SessionImageScope,
} from "@cindy/media-core/task-image-source";
import {
  hasLocalTaskImages,
  materializeTaskImageMarkdown,
} from "@cindy/media-core/task-image-markdown";
import { materializeLocalMarkdownImages } from "@cindy/media-core/local-markdown-images";
import type { AttachmentResolution } from "./input.js";

/** Node surface for the original owner database, media ledger and compensation journal. */
export class TerminalTaskMedia {
  private store!: ReturnType<typeof createPersistedMedia>["blobStore"];
  private legacyImages!: ReturnType<
    typeof createPersistedMedia
  >["imageCacheStore"];
  private runtime!: ReturnType<typeof createPersistedMedia>;
  private db!: NodeDatabase["db"]["drizzle"];
  private operations: Promise<unknown> = Promise.resolve();
  readonly ready: Promise<void>;
  /** The conversation service shares this owner's media lifecycle and journal. */
  async persisted() {
    await this.ready;
    return this.runtime;
  }
  constructor(
    private readonly profileDir: string,
    options: {
      database: NodeDatabase | Promise<NodeDatabase>;
      logger: DbLogger;
      isCurrent(): boolean;
    },
  ) {
    this.ready = this.initialize(options);
  }
  private async initialize(options: {
    database: NodeDatabase | Promise<NodeDatabase>;
    logger: DbLogger;
    isCurrent(): boolean;
  }) {
    const database = await options.database;
    const owner = database.getCurrentDbClientSnapshot();
    if (!owner) throw new Error("MEDIA_DATABASE_OWNER_UNAVAILABLE");
    const current = () =>
      options.isCurrent() && database.getCurrentDbClientSnapshot() === owner;
    const ownerScopeKey = owner.userId + ":" + owner.clientEpoch;
    this.db = database.db.drizzle;
    this.runtime = createPersistedMedia({
      database,
      logger: options.logger,
      userDataDirectory: () => this.profileDir,
      mediaDirectory: () => this.profileDir,
      owner: {
        activeOwnerScopeKey: () => (current() ? ownerScopeKey : "closed"),
        getActiveAppSession: () => ({
          dataOwnerId: current() ? owner.userId : null,
        }),
        isAppSessionBoundaryPending: () => !current(),
        dataOwnerStorageKey: (id) =>
          createHash("sha256").update(id).digest("hex").slice(0, 20),
        withCrossProcessLock,
      },
    });
    this.store = this.runtime.blobStore;
    this.legacyImages = this.runtime.imageCacheStore;
    await this.runtime.journal.reconcileMediaRefCompensationsForOwner({
      ownerId: owner.userId,
      db: this.db,
      isOwnerCurrent: current,
    });
  }
  private run<T>(action: () => Promise<T>): Promise<T> {
    const next = this.operations.then(async () => {
      await this.ready;
      return action();
    });
    this.operations = next.catch(() => {});
    return next;
  }
  ingest(
    input: {
      sessionId: string;
      bytes?: Buffer;
      path?: string;
      mimeType?: string;
      name?: string;
    },
    guard: () => void,
  ): Promise<AttachmentResolution> {
    return this.run(() => this.ingestOwned(input, guard));
  }
  private async ingestOwned(
    input: {
      sessionId: string;
      bytes?: Buffer;
      path?: string;
      mimeType?: string;
      name?: string;
      originKind?: "user" | "tool";
    },
    guard: () => void,
    newRefs?: string[],
  ): Promise<AttachmentResolution> {
    guard();
    let probe: Buffer;
    if (input.bytes) probe = input.bytes.subarray(0, 65536);
    else if (input.path) {
      const handle = await open(input.path, "r");
      try {
        const info = await handle.stat();
        if (!info.isFile()) throw new Error("INVALID_MEDIA_FILE");
        const bytes = Buffer.alloc(Math.min(info.size, 65536));
        const read = await handle.read(bytes, 0, bytes.length, 0);
        probe = bytes.subarray(0, read.bytesRead);
      } finally {
        await handle.close();
      }
    } else throw new Error("MEDIA_BYTES_REQUIRED");
    const mimeType = sniffMediaMime(probe, input.mimeType);
    if (!mimeType) throw new Error("UNRECOGNIZED_MEDIA_TYPE");
    const scope = this.runtime.journal.captureMediaRefCompensationScope();
    const check = () => {
      scope.assertStillValid();
      guard();
    };
    const written = await this.runtime.ingestMedia(
      {
        ...(input.bytes ? { buffer: input.bytes } : { filePath: input.path! }),
        mimeType,
        refs: [
          {
            refKind: "session-attachment",
            refId: input.sessionId,
            originSessionId: input.sessionId,
            originKind: input.originKind ?? "user",
            label: input.name,
          },
        ],
        assertStillValid: check,
        refCompensationScope: { ...scope, assertStillValid: check },
      },
      this.db,
    );
    newRefs?.push(...written.refIds);
    const resolved = this.store.resolveSafe(written.url);
    return {
      path: resolved.absPath,
      managedUrl: written.url,
      mimeType: written.mimeType,
    };
  }

  resolveMediaUrl(url: string) {
    return this.store.resolveSafe(url);
  }
  resolveLegacyImageUrl(url: string) {
    return this.legacyImages.resolveSafe(url);
  }
  channelMedia(
    guard: () => void,
    warn: (message: string) => void,
    fetchRemoteImage: NonNullable<IMHost["media"]>["fetchRemoteImage"],
  ): NonNullable<IMHost["media"]> {
    const cache = createIntegrationCache<LedgerDb>({
      blobStore: this.store,
      ledger: {
        getIntegrationCacheHash: (key, db) =>
          getIntegrationCacheHash(key, db ?? this.db!),
        getBlobInfo: (hash, db) => getBlobInfo(hash, db ?? this.db!),
        touchBlob: (hash, db) => touchBlob(hash, db ?? this.db!),
        addRef: (params, db) =>
          this.runtime.ledger.addRef(params, db ?? this.db!),
        removeRefById: (id, db) => removeRefById(id, db ?? this.db!),
      },
      ingestMedia: async (params) => {
        const scope = this.runtime.journal.captureMediaRefCompensationScope();
        const check = () => {
          scope.assertStillValid();
          guard();
        };
        return this.runtime.ingestMedia(
          { ...params, refs: [], assertStillValid: check },
          this.db,
        );
      },
      log: { warn },
    });
    const put = (
      params: Parameters<NonNullable<IMHost["media"]>["cacheImage"]>[0],
      kind: "image" | "av",
      isCache: boolean,
    ) =>
      this.run(async () => {
        guard();
        const hit = await cache.integrationCachePut(
          {
            ...params,
            cacheKey: integrationCacheKey(params.integration, params.token),
            mimeType: verifiedInboundMediaMime(
              params.buffer,
              params.mimeType,
              kind,
            ),
            isCache,
            assertStillValid: guard,
          },
          this.db!,
        );
        return {
          absPath: hit.absPath,
          url: hit.url,
          mimeType: hit.mimeType,
          discard: () => this.run(hit.rollbackRef),
        };
      });
    return {
      cacheImage: (params) => put(params, "image", params.staging === true),
      cacheMedia: (params) => put(params, "av", true),
      getCachedImage: (integration, token, options) =>
        this.run(async () => {
          guard();
          const hit = await cache.integrationCacheGet(
            integrationCacheKey(integration, token),
            this.db!,
          );
          guard();
          if (!hit || options?.shouldReuse?.() === false) return null;
          await pinBlob(hit.hash, this.db!);
          guard();
          return { absPath: hit.absPath, url: hit.url, mimeType: hit.mimeType };
        }),
      resolveMediaUrl: (url) => {
        guard();
        try {
          return url.startsWith("cindy-media://")
            ? this.resolveMediaUrl(url).absPath
            : url.startsWith("xdt-image://")
              ? this.resolveLegacyImageUrl(url).absPath
              : null;
        } catch {
          return null;
        }
      },
      fetchRemoteImage,
    };
  }
  /** Import only this task's workdir/native scratchpad. New refs are recorded as
   * tool output; a stale task rolls back only the pins created by this import. */
  materializeTaskImages(
    scope: SessionImageScope,
    text: string,
    guard: () => void,
    assertTaskCurrent: () => Promise<void>,
  ): Promise<string> {
    if (!hasLocalTaskImages(text)) return Promise.resolve(text);
    return this.run(async () => {
      const newRefs: string[] = [];
      try {
        guard();
        await assertTaskCurrent();
        const roots = await taskImageRoots(scope);
        guard();
        const result = await materializeTaskImageMarkdown(text, {
          importImage: async (source) => {
            const image = await readTaskImage(source, roots);
            guard();
            await assertTaskCurrent();
            guard();
            const saved = await this.ingestOwned(
              {
                sessionId: scope.id,
                bytes: image.buffer,
                mimeType: image.mimeType,
                originKind: "tool",
              },
              guard,
              newRefs,
            );
            return saved.managedUrl!;
          },
        });
        await assertTaskCurrent();
        guard();
        return result.text;
      } catch {
        for (const id of newRefs) await removeRefById(id, this.db!);
        return text;
      }
    });
  }
  channelImages(
    params: Parameters<typeof materializeLocalMarkdownImages>[0],
    materialize: (sessionId: string, text: string) => Promise<string>,
  ) {
    return materializeLocalMarkdownImages(params, {
      realpath,
      stat,
      readFile,
      materialize,
      resolveMediaUrl: (url) =>
        url.startsWith("cindy-media://")
          ? this.resolveMediaUrl(url)
          : this.resolveLegacyImageUrl(url),
    });
  }
  async resolveManaged(
    url: string,
    sessionId?: string,
  ): Promise<AttachmentResolution> {
    await this.ready;
    await this.operations;
    const resolved = this.store.resolveSafe(url);
    if (
      sessionId &&
      !(await sessionCanRead(resolved.hash, sessionId, this.db!))
    )
      throw new Error("MEDIA_SESSION_ACCESS_DENIED");
    if (!(await getBlobInfo(resolved.hash, this.db!)))
      throw new Error("MEDIA_NOT_FOUND");
    const info = await lstat(resolved.absPath);
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error("MEDIA_NOT_FOUND");
    const root = await realpath(
      path.join(this.profileDir, "cindy-media", "blobs"),
    );
    const actual = await realpath(resolved.absPath);
    const relative = path.relative(root, actual);
    if (
      relative.startsWith(".." + path.sep) ||
      relative === ".." ||
      path.isAbsolute(relative)
    )
      throw new Error("UNSAFE_MEDIA_PATH");
    return {
      path: resolved.absPath,
      managedUrl: url,
      mimeType: resolved.mimeType,
    };
  }
  removeSession(id: string): Promise<void> {
    return this.run(async () => {
      await removeRefs({ refKind: "session-attachment", refId: id }, this.db!);
    });
  }
  supportedMime(mime: string) {
    return this.store.supportedMime(mime);
  }
  private cardDb() {
    return this.db;
  }
  savePluginCard(row: GhostCardRow, guard: () => void) {
    return this.run(async () => {
      guard();
      await pluginCards.upsertGhostCard(row, this.cardDb());
    });
  }
  getPluginCard(id: string) {
    return this.run(() => pluginCards.getGhostCard(id, this.cardDb()));
  }
  listPluginCards(id: string) {
    return this.run(() =>
      pluginCards.listGhostCardsBySession(id, this.cardDb()),
    );
  }
  setPluginCardHeight(id: string, height: number) {
    return this.run(() =>
      pluginCards.updateGhostCardHeight(id, height, this.cardDb()),
    );
  }
  savePluginMedia(
    input: {
      ghostId: string;
      buffer: Uint8Array;
      mimeType: string;
      label?: string;
      assertStillValid?: () => void;
    },
    guard: () => void,
  ) {
    return this.run(async () => {
      const check = () => {
        guard();
        input.assertStillValid?.();
      };
      check();
      const scope = this.runtime.journal.captureMediaRefCompensationScope();
      const checked = () => {
        scope.assertStillValid();
        check();
      };
      const written = await this.runtime.ingestMedia(
        {
          buffer: input.buffer,
          mimeType: input.mimeType,
          refs: [
            {
              refKind: "ghost-gallery",
              refId: input.ghostId,
              originKind: "ghost",
              originId: input.ghostId,
              label: input.label,
            },
          ],
          assertStillValid: checked,
          refCompensationScope: { ...scope, assertStillValid: checked },
        },
        this.db,
      );
      return { url: written.url, hash: written.hash, ext: written.ext };
    });
  }
  relocatePlugin(from: string, to: string, guard: () => void) {
    return this.run(async () => {
      guard();
      await this.runtime.ledger.relocateGhostMediaRefs(from, to, this.db);
      guard();
      await pluginCards.reassignGhostCards(from, to, this.cardDb());
      guard();
    });
  }

  async preparePluginAttachment(
    url: string,
    sessionId: string,
    guard: () => void,
  ) {
    const resolved = await this.resolveManaged(url, sessionId);
    guard();
    const { hash } = this.store.resolveSafe(url);
    const user = await hasRef(
      {
        hash,
        refKind: "session-attachment",
        refId: sessionId,
        originKind: "user",
      },
      this.db!,
    );
    guard();
    const bytes = await readBoundedFileNoFollow(
      resolved.path,
      GHOST_FETCH_UPLOAD_MAX_BYTES_PER_FILE,
      {
        nonBlocking: true,
        containWithin: await realpath(
          path.join(this.profileDir, "cindy-media", "blobs"),
        ),
      },
    );
    guard();
    if (!bytes) throw new Error("MEDIA_NOT_FOUND");
    return {
      bytes: Buffer.from(bytes),
      mimeType: resolved.mimeType!,
      originKind: user ? ("user" as const) : ("tool" as const),
    };
  }
  grantPluginAttachments(
    instance: string,
    sources: Array<{
      bytes: Buffer;
      mimeType: string;
      originKind: "user" | "tool";
    }>,
    guard: () => void,
  ) {
    return this.run(async () => {
      const scope = this.runtime.journal.captureMediaRefCompensationScope();
      const check = () => {
        scope.assertStillValid();
        guard();
      };
      const written: Array<
        Awaited<
          ReturnType<ReturnType<typeof createPersistedMedia>["ingestMedia"]>
        > & { originKind: "user" | "tool"; id: string }
      > = [];
      for (const source of sources) {
        const item = await this.runtime.ingestMedia(
          {
            buffer: source.bytes,
            mimeType: source.mimeType,
            refs: [],
            assertStillValid: check,
          },
          this.db,
        );
        written.push({
          ...item,
          originKind: source.originKind,
          id: randomUUID(),
        });
      }
      if (!written.length) return [];
      return this.runtime.journal.withMediaRefCompensation({
        scope: { ...scope, assertStillValid: check },
        refIds: written.map((item) => item.id),
        perform: async () => {
          for (const item of written) {
            check();
            await this.runtime.ledger.addRef(
              {
                id: item.id,
                hash: item.hash,
                refKind:
                  item.originKind === "user"
                    ? "ghost-grant"
                    : "ghost-tool-grant",
                refId: instance,
                originKind: item.originKind,
              },
              this.db,
            );
          }
          check();
          return written.map((item) => item.hash);
        },
        compensate: (id) => this.runtime.ledger.removeRefById(id, this.db),
      });
    });
  }

  async readPluginMedia(instance: string, hash: string, guard: () => void) {
    await this.ready;
    await this.operations;
    guard();
    if (!(await ghostCanRead(hash, instance, this.db!))) return null;
    const info = await getBlobInfo(hash, this.db!);
    if (!info) return null;
    const resolved = await this.resolveManaged(
      `cindy-media://blobs/${hash}${info.ext}`,
    );
    guard();
    const root = await realpath(
      path.join(this.profileDir, "cindy-media", "blobs"),
    );
    guard();
    const buffer = await readBoundedFileNoFollow(
      resolved.path,
      Math.min(info.bytes, GHOST_FETCH_UPLOAD_MAX_BYTES_PER_FILE),
      { nonBlocking: true, containWithin: root },
    );
    guard();
    if (!buffer || buffer.length !== info.bytes) return null;
    return { buffer, mimeType: info.mimeType, ext: info.ext };
  }
  async close() {
    await this.ready;
    await this.operations;
  }
}
