import { createFileBrowserHandlers } from "@cindy/app-runtime/fileBrowserHandlers";
import {
  RemoteWatchRegistry,
  type RemoteWatchClient,
} from "@cindy/app-runtime/remoteFileWatch";
import {
  parseRemoteMediaUrl,
  buildRemoteMediaUrl,
} from "@cindy/maker-shared/remoteMediaUrl";
import type { Logger } from "@cindy/maker-core";
import type { TerminalSshService } from "./ssh.js";
import path from "node:path";
import { constants } from "node:fs";
import chokidar, { type FSWatcher } from "chokidar";
import { open, realpath } from "node:fs/promises";
import { gzip, gunzip } from "node:zlib";
import { promisify } from "node:util";
import {
  listDir as browseDirectories,
  statPath,
  mkdirP,
} from "@cindy/remote-agent/fsBrowse/index";
import {
  resolveWorkspacePathCached,
  resolveWorkspacePathBatchCached,
} from "@cindy/remote-agent/pathResolver";
import {
  listDir,
  readFile,
  writeFile,
  createFile,
  createFolder,
  renameEntry,
  deleteEntry,
  statEntry,
  loadIgnoreMatcher,
  listAllFilesWalk,
} from "@cindy/file-browser-core";
import {
  getSensitiveMediaBlocklist,
  isPathAllowedAgainst,
} from "@cindy/file-browser-core/filePathPolicy";
import type { InvocationContext } from "./contracts.js";
import type { TerminalRemoteContext } from "./remote/types.js";

const string = (value: unknown) => {
  if (typeof value !== "string" || !value)
    throw new Error("INVALID_FILE_ARGUMENT");
  return value;
};
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("INVALID_FILE_ARGUMENT");
  return value as Record<string, unknown>;
};
const gzipAsync = promisify(gzip),
  gunzipAsync = promisify(gunzip);
const fileOperations: Record<string, string> = {
  listDir: "list-dir",
  listAllFiles: "list-all",
  readFile: "read-file",
  stat: "stat",
  writeFile: "write-file",
  createFile: "create-file",
  createFolder: "create-folder",
  renameEntry: "rename-entry",
  deleteEntry: "delete-entry",
};

/** The same scanner/path checks as Desktop, with process-owned watches. */
export class TerminalFileBrowser {
  private watches = new Map<string, FSWatcher>();
  private readonly remoteWatches: RemoteWatchRegistry;
  private readonly remoteClients = new Map<
    string,
    { client: RemoteWatchClient; dispose(): void }
  >();
  private readonly handlers: (
    context: InvocationContext,
  ) => ReturnType<typeof createFileBrowserHandlers>;
  constructor(
    private profileDir: string,
    private emit: (channel: string, value: unknown) => void,
    private resolveManaged:
      | ((url: string) => Promise<{ path: string; mimeType: string }>)
      | undefined,
    private ssh: Pick<TerminalSshService, "files" | "media">,
    logger: Logger,
  ) {
    this.handlers = (context) =>
      createFileBrowserHandlers({
        getRemoteFileBrowser: () => ({
          request: (host, method, params) =>
            ssh.files.request(host, method, params, {
              beforeSend: () => context.assertCurrent?.(),
            }),
        }),
        getRipgrepBinaryPath: () => process.env.RIPGREP_PATH || "rg",
        logger,
      });
    this.remoteWatches = new RemoteWatchRegistry(ssh.files, logger);
  }
  async invoke(channel: string, args: unknown[], context: InvocationContext) {
    let input = object(args[0]);
    context.assertCurrent?.();
    if (channel.startsWith("fs:")) {
      if (channel === "fs:list-dir")
        return browseDirectories(
          typeof input.path === "string" ? input.path : "",
        );
      if (channel === "fs:stat-path") return statPath(string(input.path));
      if (channel === "fs:mkdir-p") return mkdirP(string(input.path));
      const options = {
        isPathAllowed: (file: string) =>
          isPathAllowedAgainst(file, this.blocklist()),
      };
      if (channel === "fs:resolve-path")
        return resolveWorkspacePathCached(
          string(input.href),
          string(input.workingDir),
          options,
        );
      if (channel === "fs:resolve-path-batch") {
        if (
          !Array.isArray(input.hrefs) ||
          input.hrefs.length > 500 ||
          input.hrefs.some((value) => typeof value !== "string")
        )
          throw new Error("INVALID_FILE_ARGUMENT");
        return resolveWorkspacePathBatchCached(
          input.hrefs as string[],
          string(input.workingDir),
          options,
        );
      }
      throw new Error("CHANNEL_NOT_ALLOWED");
    }
    if (channel === "file-browser:remote-op") {
      if (input.op === "caps")
        return {
          ok: true,
          gzip: true,
          completeDirectoryListing: true,
          fileRead: true,
        };
      if (input.op === "fileUrl") {
        const workdir = string(input.workdir),
          rel = typeof input.relPath === "string" ? input.relPath : "";
        const stat = input.remoteHostId
          ? await this.ssh.files.request(
              string(input.remoteHostId),
              "stat",
              { workdir, relPath: rel },
              { beforeSend: () => context.assertCurrent?.() },
            )
          : await statEntry(workdir, rel);
        if (stat.type !== "file") throw new Error("NOT_A_FILE");
        const url = new URL("xdt-file://open");
        url.searchParams.set(
          "path",
          input.remoteHostId
            ? path.posix.resolve(workdir, rel)
            : path.resolve(workdir, rel),
        );
        url.searchParams.set("baseDir", workdir);
        url.searchParams.set("maxBytes", String(Math.max(1, stat.size)));
        return {
          ok: true,
          url: input.remoteHostId
            ? buildRemoteMediaUrl(
                {
                  kind: "ssh",
                  remoteHostId: string(input.remoteHostId),
                  workdir,
                },
                url.href,
              )
            : url.href,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        };
      }
      const op = fileOperations[string(input.op)];
      if (!op) throw new Error("UNKNOWN_FILE_OPERATION");
      channel = `maker:file-browser:${op}`;
      if (input.contentGz !== undefined) {
        if (typeof input.contentGz !== "string" || input.content !== undefined)
          throw new Error("INVALID_FILE_ARGUMENT");
        const content = await gunzipAsync(
          Buffer.from(input.contentGz, "base64"),
          { maxOutputLength: 4 * 1024 * 1024 },
        );
        input = { ...input, content: content.toString("utf8") };
      }
    }
    const workdir = string(input.workdir);
    if (!(input.remoteHostId ? path.posix : path).isAbsolute(workdir))
      throw new Error("WORKING_DIRECTORY_MUST_BE_ABSOLUTE");
    context.assertCurrent?.();
    const rel = typeof input.relPath === "string" ? input.relPath : "";
    const handlers = this.handlers(context);
    if (Object.hasOwn(handlers, channel)) {
      const handler = handlers[channel as keyof typeof handlers];
      // Keep the original GUI response shapes and SSH retry/mutation semantics.
      const result = await handler(undefined, input as never);
      context.assertCurrent?.();
      if (channel === "maker:file-browser:read-file") {
        const response = result as {
          ok?: boolean;
          data?: { content: string; size: number; mtimeMs: number };
        };
        if (
          response.ok &&
          response.data &&
          Buffer.byteLength(JSON.stringify(response.data)) >= 1_800_000
        ) {
          if (input.acceptGzip === true) {
            const content = (
              await gzipAsync(Buffer.from(response.data.content))
            ).toString("base64");
            if (Buffer.byteLength(content) < 1_800_000)
              return {
                ok: true,
                data: { ...response.data, content, contentEncoding: "gzip" },
              };
          }
          return {
            ok: false,
            code: "OVERSIZE",
            stat: {
              relPath: rel,
              type: "file",
              size: response.data.size,
              mtimeMs: response.data.mtimeMs,
            },
          };
        }
      }
      return result;
    }
    if (input.remoteHostId) {
      const peer = context.deviceId ?? "local";
      const host = string(input.remoteHostId);
      if (channel === "maker:file-browser:stop-watch") {
        const owner = this.remoteClients.get(peer);
        if (owner)
          await this.remoteWatches.stop(owner.client.id, host, workdir);
        return { ok: true };
      }
      if (channel !== "maker:file-browser:start-watch")
        throw new Error("CHANNEL_NOT_ALLOWED");
      let owner = this.remoteClients.get(peer);
      if (!owner) {
        let disposed = false;
        const callbacks = new Set<() => void>();
        owner = {
          client: {
            id: peer,
            isDisposed: () => disposed,
            onDispose: (callback) => {
              callbacks.add(callback);
            },
          },
          dispose: () => {
            disposed = true;
            for (const callback of callbacks) callback();
            callbacks.clear();
          },
        };
        this.remoteClients.set(peer, owner);
      }
      await this.remoteWatches.start(
        owner.client,
        host,
        workdir,
        { hideMetaFiles: input.hideMetaFiles !== false },
        (event) => {
          try {
            context.assertCurrent?.();
          } catch {
            owner!.dispose();
            this.remoteClients.delete(peer);
            return;
          }
          this.emit("maker:file-browser:event", event);
        },
      );
      context.assertCurrent?.();
      return { ok: true };
    }
    switch (channel) {
      case "maker:file-browser:start-watch": {
        const root = await realpath(workdir);
        context.assertCurrent?.();
        const key = `${context.deviceId ?? "local"}:${root}`;
        if (this.watches.has(key)) return { ok: true };
        if (this.watches.size >= 16) throw new Error("WATCH_LIMIT_REACHED");
        const watcher = chokidar.watch(root, {
          ignoreInitial: true,
          followSymlinks: false,
          ignored: (file) =>
            file !== root && /[\\/](node_modules|\.git)([\\/]|$)/.test(file),
        });
        watcher.on("all", (event, filename) => {
          try {
            context.assertCurrent?.();
          } catch {
            watcher.close();
            this.watches.delete(key);
            return;
          }
          this.emit("maker:file-browser:event", {
            workdir,
            type: event,
            relPath: path.relative(root, filename).split(path.sep).join("/"),
          });
        });
        watcher.on("error", () => {
          watcher.close();
          this.watches.delete(key);
          this.emit("maker:file-browser:event", {
            workdir,
            error: "WATCH_FAILED",
          });
        });
        this.watches.set(key, watcher);
        return { ok: true };
      }
      case "maker:file-browser:stop-watch": {
        const root = await realpath(workdir);
        const key = `${context.deviceId ?? "local"}:${root}`;
        this.watches.get(key)?.close();
        this.watches.delete(key);
        return { ok: true };
      }
      default:
        throw new Error("CHANNEL_NOT_ALLOWED");
    }
  }
  private blocklist() {
    return [
      ...getSensitiveMediaBlocklist(),
      ...["secrets.enc", "machine.key", "service.json"].map((name) =>
        path.join(this.profileDir, name),
      ),
    ];
  }
  async openMedia(
    raw: string,
    context: Pick<TerminalRemoteContext, "assertCurrent">,
  ) {
    context.assertCurrent();
    const url = new URL(raw);
    const remote = parseRemoteMediaUrl(raw);
    let sshMedia: { path: string; mimeType: string } | undefined;
    if (remote?.origin.kind === "ssh") {
      const source = new URL(remote.origUrl);
      const limit = source.searchParams.get("maxBytes");
      if (
        limit !== null &&
        (!Number.isSafeInteger(Number(limit)) || Number(limit) < 1)
      )
        throw new Error("MEDIA_FILE_TOO_LARGE");
      const materialized = await this.ssh.media.materializeSshRemoteMedia(
        remote.origin,
        remote.origUrl,
        undefined,
        {
          baseDir: source.searchParams.get("baseDir") ?? undefined,
          maxBytes: limit === null ? undefined : Number(limit),
        },
      );
      context.assertCurrent();
      if (!materialized.ok) throw new Error("SSH_MEDIA_UNAVAILABLE");
      sshMedia = { path: materialized.cachePath, mimeType: materialized.mime };
    }
    const managed =
      sshMedia ??
      (url.protocol === "cindy-media:"
        ? await this.resolveManaged?.(raw)
        : undefined);
    if (
      !managed &&
      (!["xdt-file:", "xdt-audio:"].includes(url.protocol) ||
        url.searchParams.has("remoteHostId"))
    )
      throw new Error("MEDIA_REFERENCE_NOT_SUPPORTED");
    const requested = managed?.path ?? string(url.searchParams.get("path"));
    if (!path.isAbsolute(requested))
      throw new Error("MEDIA_PATH_MUST_BE_ABSOLUTE");
    const canonical = await realpath(requested);
    context.assertCurrent();
    const baseDir = url.searchParams.get("baseDir");
    if (baseDir) {
      const base = await realpath(baseDir);
      if (canonical !== base && !canonical.startsWith(base + path.sep))
        throw new Error("MEDIA_PATH_DENIED");
      context.assertCurrent();
    }
    const profile = await realpath(this.profileDir);
    context.assertCurrent();
    const protectedFiles = ["secrets.enc", "machine.key", "service.json"].map(
      (name) => path.join(profile, name),
    );
    if (
      !isPathAllowedAgainst(canonical, [
        ...getSensitiveMediaBlocklist(),
        ...protectedFiles,
      ])
    )
      throw new Error("MEDIA_PATH_DENIED");
    const handle = await open(
      canonical,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      context.assertCurrent();
      const info = await handle.stat();
      if (!info.isFile()) throw new Error("MEDIA_NOT_A_FILE");
      const limit = url.searchParams.get("maxBytes");
      if (
        limit !== null &&
        (!Number.isSafeInteger(Number(limit)) ||
          Number(limit) < 1 ||
          info.size > Number(limit))
      )
        throw new Error("MEDIA_FILE_TOO_LARGE");
      context.assertCurrent();
      const extension = path.extname(canonical).toLowerCase();
      const types: Record<string, string> = {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp",
        ".gif": "image/gif",
        ".pdf": "application/pdf",
        ".mp4": "video/mp4",
        ".mp3": "audio/mpeg",
        ".wav": "audio/wav",
        ".txt": "text/plain",
        ".md": "text/markdown",
      };
      return {
        handle,
        path: canonical,
        mimeType:
          managed?.mimeType ?? types[extension] ?? "application/octet-stream",
      };
    } catch (error) {
      await handle.close();
      throw error;
    }
  }
  stop(peer?: string) {
    for (const [id, owner] of this.remoteClients)
      if (!peer || id === peer) {
        owner.dispose();
        this.remoteClients.delete(id);
      }
    for (const [key, watcher] of this.watches)
      if (!peer || key.startsWith(`${peer}:`)) {
        watcher.close();
        this.watches.delete(key);
      }
  }
}
