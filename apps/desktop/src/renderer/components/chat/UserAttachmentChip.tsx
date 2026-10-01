import { useState } from 'react';
import { Download } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { FileTypeIcon } from '@/components/ui/file-type-icon';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { shouldOpenTextLightboxForOrigin } from '@/lib/filePreview';
import {
  isSafetyDowngradedAttachment,
  saveChatAttachmentWithToasts,
} from '@/lib/chatAttachmentSave';
import { isBrowserOpenablePath } from '../../../shared/browserOpenableExts';
import { useChatSessionFile } from './ChatSessionFileContext';
import { useFileChipContextMenu } from './useFileChipContextMenu';

/**
 * UserAttachmentChip — 用户消息下方的文件附件 chip(与正文里的 `@file` 引用
 * chip 是两种呈现;此前只有 onClick,右键无反应,与 UserFileChip 交互不一致,
 * Issue #1811 讨论中实捉)。左键保持既有行为:安全降级附件走另存流程,其余
 * 文本预览 / 交系统默认应用。右键:
 *   - 普通附件 → 共享文件 chip 菜单(复制 / 路径 / 定位等,与 UserFileChip 同款);
 *   - 安全降级附件 → 仅「另存为…」单项。受控 `.bin` 副本的路径不该经「复制
 *     文件路径 / 打开所在目录」外泄,打开类动作更会绕过降级本身。
 */
export function UserAttachmentChip({
  file,
  onOpenTextPreview,
}: {
  file: { name: string; path: string };
  /** 文本预览分支的回调:父组件记录 chip 元素(关闭预览后焦点复位)并开 lightbox。 */
  onOpenTextPreview: (chip: HTMLElement) => void;
}) {
  const { t } = useTranslation();
  const sessionFileCtx = useChatSessionFile();
  const downloadOnly = isSafetyDowngradedAttachment(file);
  // Rules-of-hooks:两个菜单 hook/状态都无条件建,按 downloadOnly 选用其一。
  const ctxMenu = useFileChipContextMenu({
    getAbsPath: () => file.path,
    canOpenInBrowser: isBrowserOpenablePath(file.path),
  });
  const [saveMenuPos, setSaveMenuPos] = useState<{ x: number; y: number } | null>(null);

  const saveOnlyMenu = (
    <DropdownMenu
      open={saveMenuPos !== null}
      onOpenChange={(open) => {
        if (!open) setSaveMenuPos(null);
      }}
    >
      <DropdownMenuTrigger asChild>
        <span
          aria-hidden
          data-fixed-menu-anchor
          style={{
            position: 'fixed',
            left: saveMenuPos?.x ?? 0,
            top: saveMenuPos?.y ?? 0,
            width: 0,
            height: 0,
            pointerEvents: 'none',
          }}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={2} onClick={(e) => e.stopPropagation()}>
        <DropdownMenuItem
          onClick={() => {
            setSaveMenuPos(null);
            void saveChatAttachmentWithToasts(sessionFileCtx, file);
          }}
        >
          <Download className="mr-2 h-4 w-4" />
          {t('chat.media.saveAs')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <>
      <button
        type="button"
        aria-label={
          downloadOnly ? t('chat.userMessage.saveAttachmentAs', { name: file.name }) : undefined
        }
        onClick={async (e) => {
          if (downloadOnly) {
            await saveChatAttachmentWithToasts(sessionFileCtx, file);
            return;
          }
          const chip = e.currentTarget;
          if (!(await shouldOpenTextLightboxForOrigin(sessionFileCtx, file.path))) return;
          onOpenTextPreview(chip);
        }}
        onContextMenu={(e) => {
          if (downloadOnly) {
            e.preventDefault();
            e.stopPropagation();
            setSaveMenuPos({ x: e.clientX, y: e.clientY });
            return;
          }
          ctxMenu.onContextMenu(e);
        }}
        className={cn(
          'inline-flex items-center gap-1.5',
          'h-7 px-2.5 py-1.5',
          'rounded-[9999px]',
          'bg-[var(--msg-user-bg)]',
          'border border-[var(--msg-user-border)]',
          'text-13 font-medium',
          'text-[var(--msg-user-text)]',
          'hover:bg-[var(--cmd-palette-item-hover)]',
          'transition-colors cursor-pointer',
          'max-w-[280px]',
        )}
      >
        {downloadOnly ? (
          <Download size={14} className="shrink-0 text-[var(--msg-user-text)]" />
        ) : (
          <FileTypeIcon name={file.name} size={14} className="shrink-0 text-[var(--msg-user-text)]" />
        )}
        <span className="truncate">{file.name}</span>
      </button>
      {downloadOnly ? saveOnlyMenu : ctxMenu.menu}
    </>
  );
}
