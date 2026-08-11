/**
 * chatAttachmentSave
 * ---------------------------------------------------------------------------
 * 聊天消息里的安全降级附件会以随机 `.bin` 文件落在受控缓存中，但展示名仍
 * 保留原始扩展名。本模块提供唯一的“另存为”业务体：源路径必须通过桌面端
 * 文件路径策略，目标名只取安全 basename，复制完成后绝不自动打开或执行。
 *
 * Electron 对话框与文件系统依赖全部注入，便于覆盖取消、路径拒绝和写入失败。
 */

import path from 'node:path';

import { samePathAndHandleFileIdentity } from './utils/fileIdentity.js';

/** Windows 保留设备名；带扩展名时同样非法，例如 `NUL.exe`。 */
const WINDOWS_RESERVED_BASENAME_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

export type ChatAttachmentSaveErrorCode =
  'invalid_source' | 'forbidden' | 'not_found' | 'not_file' | 'dialog_failed' | 'copy_failed';

export type ChatAttachmentSaveResult =
  | { status: 'saved'; savedPath: string }
  | { status: 'canceled' }
  | { status: 'error'; code: ChatAttachmentSaveErrorCode };

/** 用于确认“校验过的路径”和“实际打开的句柄”仍指向同一文件对象。 */
export interface ChatAttachmentSourceStat {
  dev: bigint;
  ino: bigint;
  isFile(): boolean;
}

/** 已打开的只读源文件；复制必须复用该句柄，不能再次按路径名打开。 */
export interface ChatAttachmentOpenedSource {
  stat(): Promise<ChatAttachmentSourceStat>;
  copyTo(targetPath: string): Promise<void>;
  close(): Promise<void>;
}

/** “另存为”业务体依赖；生产由 Electron 注入，测试使用内存 fake。 */
export interface ChatAttachmentSaveDeps {
  isPathAllowed(filePath: string): boolean;
  realpath(filePath: string): Promise<string>;
  stat(filePath: string): Promise<ChatAttachmentSourceStat>;
  openSource(filePath: string): Promise<ChatAttachmentOpenedSource>;
  showSaveDialog(opts: { defaultPath: string }): Promise<{ canceled: boolean; filePath?: string }>;
  getDownloadsDir(): string;
  getAllowedSourceRoots(): readonly string[];
}

/** 已解析真实路径是否位于某个受控缓存根内（含根自身）。 */
function isPathInsideRoot(filePath: string, rootPath: string): boolean {
  const relative = path.relative(rootPath, filePath);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

/** `dev + ino` 是已打开句柄与校验时文件对象之间的稳定身份；0 inode fail closed。 */
function isSameFileObject(
  expected: ChatAttachmentSourceStat,
  actual: ChatAttachmentSourceStat,
): boolean {
  return samePathAndHandleFileIdentity(expected, actual);
}

/**
 * 不可信展示名转成本机可用文件名：剥目录、控制字符、跨平台非法字符、前导点
 * 和尾随点/空格，并规避 Windows 设备名。保留尾部 128 字符可优先保住扩展名。
 */
export function sanitizeAttachmentSaveName(raw: unknown): string {
  const base = (typeof raw === 'string' ? raw : '').split(/[\\/]/).pop() ?? '';
  let cleaned = base
    // eslint-disable-next-line no-control-regex -- 控制字符是显式清洗目标
    .replace(/[\u0000-\u001f<>:"|?*]/g, '')
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '')
    .trim();
  if (!cleaned || cleaned === '..') return 'download.bin';
  if (cleaned.length > 128) cleaned = cleaned.slice(-128);
  if (WINDOWS_RESERVED_BASENAME_RE.test(cleaned)) cleaned = `_${cleaned}`;
  return cleaned;
}

/** 创建聊天附件“另存为”处理器。 */
export function createChatAttachmentSaveHandler(deps: ChatAttachmentSaveDeps) {
  return async function saveChatAttachment(params: {
    sourcePath?: unknown;
    suggestedName?: unknown;
  }): Promise<ChatAttachmentSaveResult> {
    const sourcePath = typeof params?.sourcePath === 'string' ? params.sourcePath : '';
    if (!sourcePath || !path.isAbsolute(sourcePath)) {
      return { status: 'error', code: 'invalid_source' };
    }
    if (!deps.isPathAllowed(sourcePath)) {
      return { status: 'error', code: 'forbidden' };
    }

    let resolvedSourcePath: string;
    try {
      resolvedSourcePath = await deps.realpath(sourcePath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | null)?.code;
      return { status: 'error', code: code === 'ENOENT' ? 'not_found' : 'forbidden' };
    }
    if (!deps.isPathAllowed(resolvedSourcePath)) {
      return { status: 'error', code: 'forbidden' };
    }

    let sourceIsInControlledCache = false;
    try {
      for (const root of deps.getAllowedSourceRoots()) {
        if (!root || !path.isAbsolute(root)) continue;
        try {
          const resolvedRoot = await deps.realpath(root);
          if (isPathInsideRoot(resolvedSourcePath, resolvedRoot)) {
            sourceIsInControlledCache = true;
            break;
          }
        } catch {
          // 未创建或不可访问的缓存根不可能授权当前源文件，继续检查其它根。
        }
      }
    } catch {
      return { status: 'error', code: 'forbidden' };
    }
    if (!sourceIsInControlledCache) {
      return { status: 'error', code: 'forbidden' };
    }

    let validatedSourceStat: ChatAttachmentSourceStat;
    try {
      const stat = await deps.stat(resolvedSourcePath);
      if (!stat.isFile()) return { status: 'error', code: 'not_file' };
      validatedSourceStat = stat;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | null)?.code;
      return { status: 'error', code: code === 'ENOENT' ? 'not_found' : 'not_file' };
    }

    let dialogResult: { canceled: boolean; filePath?: string };
    try {
      dialogResult = await deps.showSaveDialog({
        defaultPath: path.join(
          deps.getDownloadsDir(),
          sanitizeAttachmentSaveName(params?.suggestedName),
        ),
      });
    } catch {
      return { status: 'error', code: 'dialog_failed' };
    }
    if (dialogResult.canceled || !dialogResult.filePath) return { status: 'canceled' };

    let openedSource: ChatAttachmentOpenedSource | null = null;
    try {
      openedSource = await deps.openSource(resolvedSourcePath);
      const openedStat = await openedSource.stat();
      if (!openedStat.isFile()) return { status: 'error', code: 'not_file' };
      if (!isSameFileObject(validatedSourceStat, openedStat)) {
        return { status: 'error', code: 'forbidden' };
      }
      // 从已经 fstat 核对过的同一文件句柄流式复制，杜绝再次按路径名打开。
      await openedSource.copyTo(dialogResult.filePath);
      return { status: 'saved', savedPath: dialogResult.filePath };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | null)?.code;
      if (code === 'ENOENT') return { status: 'error', code: 'not_found' };
      if (code === 'ELOOP') return { status: 'error', code: 'forbidden' };
      return { status: 'error', code: 'copy_failed' };
    } finally {
      if (openedSource) await openedSource.close().catch(() => undefined);
    }
  };
}
