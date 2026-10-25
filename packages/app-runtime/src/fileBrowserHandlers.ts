import {
  listAllFiles,
  listDir,
  loadIgnoreMatcher,
  readFile,
  renameEntry,
  statEntry,
  writeFile,
  createFile,
  createFolder,
  deleteEntry,
} from "@cindy/file-browser-core";
import {
  throwRemoteFsIpcError,
  type RemoteFileBrowserManager,
} from "./remoteFileBrowser.js";
import type { DbLogger } from "@cindy/runtime-db/logging";
interface RemoteRoutedArgs {
  remoteHostId?: string | null;
}
interface ListDirArgs extends RemoteRoutedArgs {
  /** Bypass presentation filters; does not bypass filesystem access checks. */
  includeIgnored?: boolean;
  workdir: string;
  /** workdir-relative POSIX path; '' for root */
  relPath?: string;
  /** default true — Unity .meta files cut ~47% of typical entries */
  hideMetaFiles?: boolean;
  /** Doc mode: only `.md` files + dirs that contain `.md` descendants. */
  docMode?: boolean;
}
interface ReadFileArgs extends RemoteRoutedArgs {
  workdir: string;
  relPath: string;
}
interface WriteFileArgs extends RemoteRoutedArgs {
  workdir: string;
  relPath: string;
  content: string;
}
interface MutateEntryArgs extends RemoteRoutedArgs {
  workdir: string;
  relPath: string;
}
interface RenameEntryArgs extends RemoteRoutedArgs {
  workdir: string;
  fromRel: string;
  toRel: string;
}
interface StatArgs extends RemoteRoutedArgs {
  workdir: string;
  relPath: string;
}
export function createFileBrowserHandlers(host: {
  getRemoteFileBrowser(): Pick<RemoteFileBrowserManager, "request">;
  getRipgrepBinaryPath(): string;
  logger: DbLogger;
}) {
  const { getRemoteFileBrowser, getRipgrepBinaryPath, logger: log } = host;
  return {
    "maker:file-browser:list-dir": async (
      _event: unknown,
      args: ListDirArgs,
    ) => {
      if (args.remoteHostId) {
        try {
          const { entries } = await getRemoteFileBrowser().request(
            args.remoteHostId,
            "listDir",
            {
              workdir: args.workdir,
              relPath: args.relPath ?? "",
              hideMetaFiles: args.hideMetaFiles ?? true,
              docMode: args.docMode,
              includeIgnored: args.includeIgnored,
            },
          );
          return entries;
        } catch (err) {
          log.warn("remote list-dir failed", {
            hostId: args.remoteHostId,
            error: String(err),
          });
          throwRemoteFsIpcError(err);
        }
      }
      const matcher =
        args.includeIgnored === true
          ? null
          : await loadIgnoreMatcher(args.workdir, {
              hideMetaFiles: args.hideMetaFiles ?? true,
              honorVcsIgnore: false,
            });
      return listDir(args.workdir, args.relPath ?? "", matcher, {
        docMode: args.includeIgnored === true ? false : args.docMode,
      });
    },
    "maker:file-browser:list-all": async (
      _event: unknown,
      args: { workdir: string; cap?: number } & RemoteRoutedArgs,
    ) => {
      if (args.remoteHostId) {
        // 远端 daemon 内 spawn 远端 rg;远端无 rg 时 daemon 返回 BAD_REQUEST,
        // 走同款空 fallback(renderer 渲染"未索引"占位),不 throw。
        try {
          return await getRemoteFileBrowser().request(
            args.remoteHostId,
            "listAllFiles",
            {
              workdir: args.workdir,
              cap: args.cap,
            },
          );
        } catch (err) {
          log.warn("remote list-all failed", {
            hostId: args.remoteHostId,
            error: String(err),
          });
          // RG_UNAVAILABLE 透传稳定 token(renderer 按码映射"远端无 ripgrep"文案),
          // 其余保留原始描述进通用"索引失败"占位。
          const code = (err as Error & { code?: string }).code;
          return {
            files: [] as string[],
            truncated: false,
            elapsedMs: 0,
            error: code === "RG_UNAVAILABLE" ? "RG_UNAVAILABLE" : String(err),
          };
        }
      }
      try {
        const rgPath = getRipgrepBinaryPath();
        return await listAllFiles({
          workdir: args.workdir,
          rgPath,
          cap: args.cap,
        });
      } catch (err) {
        log.warn("list-all failed", {
          workdir: args.workdir,
          error: String(err),
        });
        // 查询型 handler:rg 跑挂 / 二进制缺失等情况下,renderer 仍需要一个合法
        // 空结果 fallback 渲染("没索引到文件"占位),所以返回 success:false 而不
        // 是 throw(规则 13 例外条款,跟 LIST_AGENT_SKILLS 同模式)。
        return {
          files: [] as string[],
          truncated: false,
          elapsedMs: 0,
          error: String(err),
        };
      }
    },
    "maker:file-browser:read-file": async (
      _event: unknown,
      args: ReadFileArgs,
    ) => {
      try {
        const data = args.remoteHostId
          ? await getRemoteFileBrowser().request(
              args.remoteHostId,
              "readFile",
              {
                workdir: args.workdir,
                relPath: args.relPath,
              },
            )
          : await readFile(args.workdir, args.relPath);
        return { ok: true as const, data };
      } catch (err) {
        const code = (err as Error & { code?: string }).code;
        // BINARY_FILE is the expected "not previewable" path — surface it
        // explicitly so the renderer can show the unrenderable placeholder
        // without log spam. 远程侧 daemon 透传同一 code(FileServiceRpcError)。
        if (code === "BINARY_FILE") {
          return { ok: false as const, code: "BINARY_FILE" as const };
        }
        log.warn("read-file failed", { args, error: String(err) });
        return {
          ok: false as const,
          code: "READ_FAILED" as const,
          message: String(err),
        };
      }
    },
    "maker:file-browser:stat": async (_event: unknown, args: StatArgs) => {
      if (args.remoteHostId) {
        try {
          return await getRemoteFileBrowser().request(
            args.remoteHostId,
            "stat",
            {
              workdir: args.workdir,
              relPath: args.relPath,
            },
          );
        } catch (err) {
          throwRemoteFsIpcError(err);
        }
      }
      return statEntry(args.workdir, args.relPath);
    },
    "maker:file-browser:write-file": async (
      _event: unknown,
      args: WriteFileArgs,
    ) => {
      try {
        const result = args.remoteHostId
          ? await getRemoteFileBrowser().request(
              args.remoteHostId,
              "writeFile",
              {
                workdir: args.workdir,
                relPath: args.relPath,
                content: args.content,
              },
            )
          : await writeFile(args.workdir, args.relPath, args.content);
        return { ok: true as const, ...result };
      } catch (err) {
        log.warn("write-file failed", {
          relPath: args.relPath,
          error: String(err),
        });
        return { ok: false as const, message: String(err) };
      }
    },
    "maker:file-browser:create-file": async (
      _event: unknown,
      args: MutateEntryArgs,
    ) => {
      try {
        const stat = args.remoteHostId
          ? await getRemoteFileBrowser().request(
              args.remoteHostId,
              "createFile",
              {
                workdir: args.workdir,
                relPath: args.relPath,
              },
            )
          : await createFile(args.workdir, args.relPath);
        return { ok: true as const, stat };
      } catch (err) {
        log.warn("create-file failed", {
          relPath: args.relPath,
          error: String(err),
        });
        return { ok: false as const, message: String(err) };
      }
    },
    "maker:file-browser:create-folder": async (
      _event: unknown,
      args: MutateEntryArgs,
    ) => {
      try {
        const stat = args.remoteHostId
          ? await getRemoteFileBrowser().request(
              args.remoteHostId,
              "createFolder",
              {
                workdir: args.workdir,
                relPath: args.relPath,
              },
            )
          : await createFolder(args.workdir, args.relPath);
        return { ok: true as const, stat };
      } catch (err) {
        log.warn("create-folder failed", {
          relPath: args.relPath,
          error: String(err),
        });
        return { ok: false as const, message: String(err) };
      }
    },
    "maker:file-browser:rename-entry": async (
      _event: unknown,
      args: RenameEntryArgs,
    ) => {
      try {
        const stat = args.remoteHostId
          ? await getRemoteFileBrowser().request(
              args.remoteHostId,
              "renameEntry",
              {
                workdir: args.workdir,
                fromRel: args.fromRel,
                toRel: args.toRel,
              },
            )
          : await renameEntry(args.workdir, args.fromRel, args.toRel);
        return { ok: true as const, stat };
      } catch (err) {
        log.warn("rename-entry failed", {
          fromRel: args.fromRel,
          toRel: args.toRel,
          error: String(err),
        });
        return { ok: false as const, message: String(err) };
      }
    },
    "maker:file-browser:delete-entry": async (
      _event: unknown,
      args: MutateEntryArgs,
    ) => {
      try {
        if (args.remoteHostId) {
          await getRemoteFileBrowser().request(
            args.remoteHostId,
            "deleteEntry",
            {
              workdir: args.workdir,
              relPath: args.relPath,
            },
          );
        } else {
          await deleteEntry(args.workdir, args.relPath);
        }
        return { ok: true as const };
      } catch (err) {
        log.warn("delete-entry failed", {
          relPath: args.relPath,
          error: String(err),
        });
        return { ok: false as const, message: String(err) };
      }
    },
  };
}
