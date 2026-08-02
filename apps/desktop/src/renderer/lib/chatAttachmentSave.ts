/**
 * chatAttachmentSave — 安全降级聊天附件的 renderer 分流。
 *
 * 物化后的真实路径为 `.bin`、展示名仍带原扩展名时，点击动作必须从
 * `openPath` 切到受控“另存为”。远程会话先复用聊天文件取回缓存链路，保证
 * 本机 IPC 永远只接收本地副本路径。
 */

import { i18n } from '@/i18n';
import {
  attachmentExtension,
  isDangerousAttachmentName,
} from '../../shared/attachmentSafety';
import { toast } from './toast';
import { fetchChatFileWithToasts } from './remoteFileOpen';
import { isRemoteFileOrigin, type SessionFileOrigin } from './sessionFileOrigin';

/** 消息持久化中可用于展示和取件的最小文件引用。 */
export interface ChatAttachmentFile {
  name: string;
  path: string;
}

type SaveResult = Awaited<ReturnType<typeof window.electronAPI.saveChatAttachmentAs>>;

/** 安全另存流程依赖；默认接真实 IPC/toast，单测可注入确定性 fake。 */
export interface ChatAttachmentSaveDeps {
  platform: string;
  stageDangerous(params: {
    sourcePath: string;
    suggestedName: string;
  }): ReturnType<typeof window.electronAPI.stageChatAttachment>;
  cleanupStaged?: (filePaths: readonly string[]) => Promise<void>;
  fetchRemoteFile(
    origin: Exclude<SessionFileOrigin, { kind: 'local' }>,
    workingDir: string,
    sourcePath: string,
  ): Promise<string | null>;
  saveAs(params: { sourcePath: string; suggestedName: string }): Promise<SaveResult>;
  success(message: string): void;
  warning(message: string): void;
  error(message: string): void;
}

/**
 * 危险原始类型无论当前物理路径是什么都只能另存；历史版本已经把安全格式
 * 降级成 `.bin` 的附件也继续走另存，以便恢复原始扩展名。
 */
export function isSafetyDowngradedAttachment(file: ChatAttachmentFile): boolean {
  return (
    isDangerousAttachmentName(file.name) ||
    isDangerousAttachmentName(file.path) ||
    (attachmentExtension(file.path) === '.bin' && attachmentExtension(file.name) !== '.bin')
  );
}

/** 已知不能由当前桌面平台直接使用的安装/可执行格式。 */
export function isAttachmentUnsupportedOnPlatform(fileName: string, platform: string): boolean {
  const ext = attachmentExtension(fileName);
  if (platform === 'darwin') return ext === '.exe' || ext === '.msi';
  if (platform === 'win32') return ext === '.dmg' || ext === '.pkg' || ext === '.app';
  if (platform === 'linux') {
    return ext === '.exe' || ext === '.msi' || ext === '.dmg' || ext === '.pkg' || ext === '.app';
  }
  return false;
}

function defaultDeps(): ChatAttachmentSaveDeps {
  return {
    platform: window.electronAPI.platform,
    stageDangerous: (params) => window.electronAPI.stageChatAttachment(params),
    cleanupStaged: (filePaths) => window.electronAPI.cleanupStagedChatAttachments(filePaths),
    fetchRemoteFile: fetchChatFileWithToasts,
    saveAs: (params) => window.electronAPI.saveChatAttachmentAs(params),
    success: (message) => {
      toast.success(message);
    },
    warning: (message) => {
      toast.warning(message);
    },
    error: (message) => {
      toast.error(message);
    },
  };
}

/**
 * 弹出安全另存流程。取消不提示；成功与已知平台不兼容分别用 success/warning；
 * 错误按用户可操作原因分流，不向 renderer 暴露主进程路径或异常细节。
 */
export async function saveChatAttachmentWithToasts(
  ctx: { origin: SessionFileOrigin; workingDir: string },
  file: ChatAttachmentFile,
  deps: ChatAttachmentSaveDeps = defaultDeps(),
): Promise<'saved' | 'canceled' | 'failed'> {
  let sourcePath = isRemoteFileOrigin(ctx.origin)
    ? await deps.fetchRemoteFile(ctx.origin, ctx.workingDir, file.path)
    : file.path;
  if (!sourcePath) return 'failed';
  let stagedForSave: string | null = null;

  // Messages sent before the staging fix may still reference the user's
  // original executable path. Copy those legacy local sources into the inert
  // cache on demand before invoking the cache-only Save As handler.
  if (
    !isRemoteFileOrigin(ctx.origin) &&
    (isDangerousAttachmentName(file.name) || isDangerousAttachmentName(sourcePath)) &&
    attachmentExtension(sourcePath) !== '.bin'
  ) {
    try {
      const staged = await deps.stageDangerous({
        sourcePath,
        suggestedName: file.name,
      });
      if (!staged.success) {
        deps.error(i18n.t('chat.userMessage.attachmentSaveForbidden'));
        return 'failed';
      }
      sourcePath = staged.path;
      stagedForSave = staged.path;
    } catch {
      deps.error(i18n.t('chat.userMessage.attachmentSaveFailed'));
      return 'failed';
    }
  }

  const cleanupStagedForSave = () => {
    if (!stagedForSave || !deps.cleanupStaged) return;
    void deps.cleanupStaged([stagedForSave]).catch(() => undefined);
  };

  let result: SaveResult;
  try {
    result = await deps.saveAs({ sourcePath, suggestedName: file.name });
  } catch {
    cleanupStagedForSave();
    deps.error(i18n.t('chat.userMessage.attachmentSaveFailed'));
    return 'failed';
  }

  cleanupStagedForSave();

  if (result.status === 'canceled') return 'canceled';
  if (result.status === 'saved') {
    if (isAttachmentUnsupportedOnPlatform(file.name, deps.platform)) {
      deps.warning(i18n.t('chat.userMessage.attachmentSavedUnsupported', { name: file.name }));
    } else {
      deps.success(i18n.t('chat.userMessage.attachmentSaved', { name: file.name }));
    }
    return 'saved';
  }

  if (result.code === 'not_found' || result.code === 'not_file') {
    deps.error(i18n.t('chat.userMessage.attachmentSourceMissing'));
  } else if (result.code === 'invalid_source' || result.code === 'forbidden') {
    deps.error(i18n.t('chat.userMessage.attachmentSaveForbidden'));
  } else {
    deps.error(i18n.t('chat.userMessage.attachmentSaveFailed'));
  }
  return 'failed';
}
