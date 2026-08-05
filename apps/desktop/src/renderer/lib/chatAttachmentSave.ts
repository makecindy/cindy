/**
 * chatAttachmentSave — 安全降级聊天附件的 renderer 分流。
 *
 * 物化后的真实路径为 `.bin`、展示名仍带原扩展名时，点击动作必须从
 * `openPath` 切到受控“另存为”。远程会话先复用聊天文件取回缓存链路，保证
 * 本机 IPC 永远只接收本地副本路径。
 */

import { i18n } from '@/i18n';
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

function extensionOf(value: string): string {
  const base = value.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot).toLowerCase() : '';
}

/**
 * 展示名与实际缓存扩展不一致且实际为 `.bin`，即物化阶段执行过安全降级。
 * 原名本来就是 `.bin` 时保持历史打开行为，不误判为恢复扩展名场景。
 */
export function isSafetyDowngradedAttachment(file: ChatAttachmentFile): boolean {
  return extensionOf(file.path) === '.bin' && extensionOf(file.name) !== '.bin';
}

/** 已知不能由当前桌面平台直接使用的安装/可执行格式。 */
export function isAttachmentUnsupportedOnPlatform(fileName: string, platform: string): boolean {
  const ext = extensionOf(fileName);
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
  const sourcePath = isRemoteFileOrigin(ctx.origin)
    ? await deps.fetchRemoteFile(ctx.origin, ctx.workingDir, file.path)
    : file.path;
  if (!sourcePath) return 'failed';

  let result: SaveResult;
  try {
    result = await deps.saveAs({ sourcePath, suggestedName: file.name });
  } catch {
    deps.error(i18n.t('chat.userMessage.attachmentSaveFailed'));
    return 'failed';
  }

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
