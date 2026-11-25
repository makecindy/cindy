/**
 * FilePreviewLightboxHost — 文件预览浮层的会话级宿主(issue #12851)。
 *
 * 预览原本是 AgentActionRow 的局部 state:那一行被卸载,浮层跟着消失 ——
 * 运行中的实时预览区收起、「最近 5 条」把旧行挤出、work group 换 key 重挂,
 * 都会让用户正看着的文件预览凭空不见(用户并没有点关闭)。
 *
 * 预览属于「用户正在看这个文件」这件事,不属于任何一行工具,所以提升到这里:
 * 宿主挂在 MessageStream 顶层,上面三条卸载路径都碰不到它。
 *
 * 「文件已变更」角标也挂在同一个宿主:Agent 在预览期间改了正在看的文件时只提示,
 * 不自动换内容(正在读的内容不该被突然替换),用户点一下才重新读。
 *
 * 图片预览(ImageLightbox)不在这里:它依赖按消息项挂载的 ImageGalleryContext
 * (会话里翻看同一张消息的图片),提升到会话级会丢掉这个上下文,留在原处。
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Tip } from '@/components/ui/tooltip';
import { wasFileChangedInMessages } from '@/features/right-sidebar/lib/lastTurnChangedFiles';
import { makerChatStore, type ChatMessage } from '@/lib/makerChatStore';

import { useChatSessionFile } from './ChatSessionFileContext';
import { TextLightbox } from './lazyPreviewLightboxes';
import { ToolPayloadLightbox, type ToolPayloadMode } from './ToolPayloadLightbox';

/** 一次「打开文件预览」的请求。 */
export type FilePreviewRequest =
  | {
      kind: 'document';
      /** 会话 id:决定「文件已变更」看哪个会话的消息。 */
      sessionId: string | undefined;
      /** 预览文件的绝对路径。 */
      filePath: string;
      /** 工具栏显示名;缺省用路径 basename。 */
      fileName?: string;
      /** 关闭后焦点回到的入口元素。 */
      triggerRef?: RefObject<HTMLElement | null>;
    }
  | {
      kind: 'diff';
      sessionId: string | undefined;
      /** 文件改动 diff(Edit / Write / file_change 工具产出)。 */
      payload: ToolPayloadMode;
      triggerRef?: RefObject<HTMLElement | null>;
    };

interface FilePreviewLightboxContextValue {
  open(request: FilePreviewRequest): void;
}

const FilePreviewLightboxContext = createContext<FilePreviewLightboxContextValue | null>(null);

/**
 * 消费入口:没有宿主时为 null —— 调用方保留自己就地渲染的退路,
 * 不因为宿主缺席就失去「点开文件」的能力。
 */
export function useFilePreviewLightbox(): FilePreviewLightboxContextValue | null {
  return useContext(FilePreviewLightboxContext);
}

/** 预览期间文件被改动时的提示:点一下才刷新内容。 */
export function FileChangedBadge({ onClick }: { onClick(): void }) {
  const { t } = useTranslation();
  return (
    <Tip text={t('chat.filePreview.refreshHint')}>
      <Button variant="secondary" size="md" compact onClick={onClick}>
        <RefreshCw size={14} aria-hidden />
        {t('chat.filePreview.changed')}
      </Button>
    </Tip>
  );
}

/**
 * 宿主组件:持有「当前打开的预览」,并在 Agent 改动该文件时给出提示。
 *
 * 挂在 MessageStream 顶层(会话文件上下文之内),所以远程会话的文件来源与
 * 工作目录都跟着会话走,浮层内容与右侧栏文件浏览器一致。
 */
export function FilePreviewLightboxProvider({ children }: { children?: ReactNode }) {
  const { workingDir } = useChatSessionFile();
  const [preview, setPreview] = useState<FilePreviewRequest | null>(null);
  const [changed, setChanged] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);

  const open = useCallback((request: FilePreviewRequest) => {
    setPreview(request);
    setChanged(false);
    setRefreshToken(0);
  }, []);

  const close = useCallback(() => {
    setPreview(null);
    setChanged(false);
  }, []);

  const refresh = useCallback(() => {
    setRefreshToken((token) => token + 1);
    setChanged(false);
  }, []);

  // 只有文稿预览有「文件已变更」这回事(diff 是打开瞬间的快照)。
  const documentPath = preview?.kind === 'document' ? preview.filePath : null;

  // 预览期间 Agent 改了正在看的文件 → 只提示,不自动换内容。
  useEffect(() => {
    const sessionId = preview?.sessionId;
    if (!sessionId || !documentPath) return;
    // 打开瞬间已存在的消息不算「预览期间的改动」。
    const known = new Set(makerChatStore.getSnapshot(sessionId).messages.map((m) => m.clientId));
    const check = () => {
      const messages = makerChatStore.getSnapshot(sessionId).messages;
      // 流式期间新消息追加在尾部:从尾往前扫到已知 id 为止,只看新增量。
      const fresh: ChatMessage[] = [];
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const message = messages[i]!;
        if (known.has(message.clientId)) break;
        fresh.push(message);
      }
      if (fresh.length === 0) return;
      for (const message of fresh) known.add(message.clientId);
      fresh.reverse();
      if (wasFileChangedInMessages(fresh, workingDir, documentPath)) setChanged(true);
    };
    return makerChatStore.subscribe(sessionId, check);
  }, [preview?.sessionId, documentPath, workingDir]);

  const value = useMemo(() => ({ open }), [open]);

  return (
    <FilePreviewLightboxContext.Provider value={value}>
      {children}
      {preview?.kind === 'diff' ? (
        <ToolPayloadLightbox
          payload={preview.payload}
          triggerRef={preview.triggerRef}
          onClose={close}
        />
      ) : preview ? (
        <TextLightbox
          filePath={preview.filePath}
          fileName={preview.fileName}
          triggerRef={preview.triggerRef}
          onClose={close}
          refreshToken={refreshToken}
          changedBadge={changed ? <FileChangedBadge onClick={refresh} /> : undefined}
        />
      ) : null}
    </FilePreviewLightboxContext.Provider>
  );
}
