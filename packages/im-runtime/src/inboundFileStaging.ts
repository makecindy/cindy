import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { IMAttachment, IMHostFileStaging } from "@cindy/im";
import type { Logger } from "@cindy/maker-core";
export const STAGING_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
export function createInboundFileStaging(host: {
  ownerScopedImUserDataPath(...segments: string[]): string;
  createLogger(scope: string): Pick<Logger, "warn">;
  ensureDirectory?(directory: string): Promise<unknown>;
}) {
  const { ownerScopedImUserDataPath, createLogger } = host;
  const ensureDirectory =
    host.ensureDirectory ??
    (async (directory: string) => {
      await fs.mkdir(directory, { recursive: true });
    });
  /**
   * main/im/shared/inboundFileStaging.ts
   * ---------------------------------------------------------------------------
   * 个人 IM 渠道入站**非媒体文件**(PDF / docx / zip …)的受控存放。媒体(图片/
   * 音视频)走 cindy-media 总仓, 不经这里。
   *
   * 目录(按账号隔离, 与微信 `mediaStaging.ts` 同一棵树):
   *   im-attachments/<channel>/staging/<uuid>-<name>            ← transport 下载时(任务未知)
   *   im-attachments/<channel>/sessions/<sessionId>/<uuid>-<name> ← 路由到任务后移入
   *
   * 生命周期:
   *   - transport 经 `IMHost.files.stage` 写入 staging(下载时还不知道归哪个任务);
   *   - turnRunner 在任务确定后、把路径交给模型/落库之前调用 `adoptStagedInboundFiles`
   *     原地改写 absPath 为任务目录下的路径 —— 只领养触发消息自己的附件(会落库);
   *     群历史附件只进本轮模型、不落库, 留在 staging 按龄回收;
   *   - 任务删除时 `removeImSessionAttachmentDirs` 清掉所有渠道下该任务的目录;
   *   - 没被任何任务领走的 staging 文件(消息被丢弃/拒绝)在下次暂存时按龄清理。
   *
   * 不写 `cc-agent/*-media`: 那是冻结的历史兼容层(媒体规则), 只读。
   */

  const log = createLogger("im/inbound-file-staging");

  const ROOT_DIR = "im-attachments";
  const STAGING_DIR = "staging";
  const SESSIONS_DIR = "sessions";
  /** staging 里超过这个年龄的文件视为无人认领(消息已被丢弃), 下次暂存时清掉。 */

  /** 同一 staging 目录两次清扫的最小间隔。 */
  const SWEEP_INTERVAL_MS = 60 * 60 * 1_000;

  type Integration = Parameters<IMHostFileStaging["stage"]>[0]["integration"];

  const lastSweepAt = new Map<string, number>();
  const UUID_PREFIX =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/i;

  function isWithin(root: string, candidate: string): boolean {
    const relative = path.relative(root, candidate);
    return (
      relative !== "" &&
      !relative.startsWith("..") &&
      !path.isAbsolute(relative)
    );
  }

  /**
   * 文件名(不含 `<uuid>-` 前缀)的 UTF-8 字节上限。常见文件系统单个文件名上限
   * 255 字节, 再减去 37 字节前缀并留余量 —— 中文名按字符截断会超限(ENAMETOOLONG)。
   */
  const MAX_NAME_BYTES = 200;

  function truncateUtf8(value: string, maxBytes: number): string {
    let out = "";
    let bytes = 0;
    for (const ch of value) {
      const size = Buffer.byteLength(ch, "utf8");
      if (bytes + size > maxBytes) break;
      out += ch;
      bytes += size;
    }
    return out;
  }

  /** 平台文件名不可信: 去路径分隔与保留字符、按 UTF-8 字节截断, 保留扩展名。 */
  function sanitizeInboundFileName(name: string): string {
    const base = path.basename(name.replace(/\\/g, "/"));
    // eslint-disable-next-line no-control-regex
    const cleaned = base
      .replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_")
      .replace(/^\.+/, "")
      .trim();
    if (!cleaned) return "attachment";
    if (Buffer.byteLength(cleaned, "utf8") <= MAX_NAME_BYTES) return cleaned;
    const rawExt = path.extname(cleaned);
    const ext = Buffer.byteLength(rawExt, "utf8") <= 16 ? rawExt : "";
    const stem = cleaned.slice(0, cleaned.length - rawExt.length);
    return (
      `${truncateUtf8(stem, MAX_NAME_BYTES - Buffer.byteLength(ext, "utf8"))}${ext}` ||
      "attachment"
    );
  }

  function stagingDir(integration: Integration): string {
    return path.resolve(
      ownerScopedImUserDataPath(ROOT_DIR, integration, STAGING_DIR),
    );
  }

  async function sweepStaleStaging(dir: string, now: number): Promise<void> {
    const last = lastSweepAt.get(dir) ?? 0;
    if (now - last < SWEEP_INTERVAL_MS) return;
    lastSweepAt.set(dir, now);
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      return;
    }
    await Promise.all(
      names.map(async (name) => {
        const candidate = path.join(dir, name);
        try {
          const stat = await fs.lstat(candidate);
          if (stat.isFile() && now - stat.mtimeMs > STAGING_MAX_AGE_MS) {
            await fs.rm(candidate, { force: true });
          }
        } catch {
          /* 并发移走/删掉: 忽略 */
        }
      }),
    );
  }

  async function stageInboundFile(params: {
    integration: Integration;
    buffer: Uint8Array;
    fileName: string;
  }): Promise<{ absPath: string; discard: () => Promise<void> }> {
    const dir = stagingDir(params.integration);
    await ensureDirectory(dir);
    void sweepStaleStaging(dir, Date.now()).catch(() => undefined);
    const absPath = path.join(
      dir,
      `${randomUUID()}-${sanitizeInboundFileName(params.fileName)}`,
    );
    if (!isWithin(dir, absPath))
      throw new Error("IM_INBOUND_FILE_PATH_OUT_OF_BOUNDS");
    await fs.writeFile(absPath, params.buffer, { flag: "wx" });
    return {
      absPath,
      discard: async () => {
        await fs.rm(absPath, { force: true });
      },
    };
  }

  const inboundFileStaging: IMHostFileStaging = { stage: stageInboundFile };

  /**
   * 让附件落在**该任务自己的**附件目录, 原地改写 absPath:
   *   - 仍在 staging 的: 移入(rename; 跨卷等失败时复制后删暂存);
   *   - 已在别的任务目录的(早落库归到 A、派发时换到 B): 复制一份给本任务, A 的
   *     落库记录仍指向它自己那份 —— 删除任一任务都不影响另一个;
   *   - 媒体总仓、历史目录、已在本任务目录的: 不动。
   * 移入失败时保留原路径(文件仍可读), 不阻断本轮。
   */
  async function adoptStagedInboundFiles(
    sessionId: string,
    attachments: readonly IMAttachment[],
  ): Promise<void> {
    if (attachments.length === 0) return;
    const root = path.resolve(ownerScopedImUserDataPath(ROOT_DIR));
    for (const attachment of attachments) {
      const source = path.resolve(attachment.absPath);
      if (!isWithin(root, source)) continue;
      const parts = path.relative(root, source).split(path.sep);
      const [integration, bucket] = parts;
      const fileName = parts[parts.length - 1];
      const fromStaging = bucket === STAGING_DIR && parts.length === 3;
      const fromOtherSession =
        bucket === SESSIONS_DIR && parts.length === 4 && parts[2] !== sessionId;
      if (!integration || !fileName || (!fromStaging && !fromOtherSession))
        continue;
      const sessionsRoot = path.resolve(root, integration, SESSIONS_DIR);
      const targetDir = path.resolve(sessionsRoot, sessionId);
      if (!isWithin(sessionsRoot, targetDir)) continue;
      const target = path.join(
        targetDir,
        fromStaging
          ? fileName
          : `${randomUUID()}-${fileName.replace(UUID_PREFIX, "")}`,
      );
      try {
        await ensureDirectory(targetDir);
        if (fromStaging) {
          try {
            await fs.rename(source, target);
          } catch {
            await fs.copyFile(source, target);
            await fs.rm(source, { force: true }).catch(() => undefined);
          }
        } else {
          await fs.copyFile(source, target);
        }
        attachment.absPath = target;
      } catch (err) {
        log.warn("adopt IM inbound file failed (kept original path)", {
          sessionId,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /** 当前账号的 im-attachments 根目录(异步清理应在发起时同步捕获, 不在执行时重新解析)。 */
  function imAttachmentsRoot(): string {
    return path.resolve(ownerScopedImUserDataPath(ROOT_DIR));
  }

  /**
   * 任务删除: 清掉所有渠道下该任务的附件目录(含微信)。`root` 由发起删除的一方捕获
   * 传入 —— 执行时账号可能已切换, 不能按当前账号重新解析。
   */
  async function removeImSessionAttachmentDirs(
    sessionId: string,
    root: string = imAttachmentsRoot(),
  ): Promise<void> {
    let integrations: string[];
    try {
      integrations = await fs.readdir(root);
    } catch {
      return;
    }
    await Promise.all(
      integrations.map(async (integration) => {
        const sessionsRoot = path.resolve(root, integration, SESSIONS_DIR);
        const target = path.resolve(sessionsRoot, sessionId);
        if (!isWithin(sessionsRoot, target)) return;
        await fs.rm(target, { recursive: true, force: true });
      }),
    );
  }

  /** 测试用: 重置清扫节流。 */
  function resetInboundFileStagingForTests(): void {
    lastSweepAt.clear();
  }

  return {
    stageInboundFile,
    inboundFileStaging,
    adoptStagedInboundFiles,
    imAttachmentsRoot,
    removeImSessionAttachmentDirs,
    resetInboundFileStagingForTests,
    sanitizeInboundFileName,
  };
}
