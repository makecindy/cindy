/**
 * ChatFileChipMenuSheet — 聊天正文文件 chip 长按操作菜单。
 *
 * 复用模型选择面板同一套浮动面板组件(ContextSheet → SheetSurface:同款
 * grabber / header / 半屏吸附 / 遮罩关闭),不另造菜单容器,保证全 app 面板
 * 观感一致(产品 2026-07-05 要求)。动作行走 ContextSheetGroup / ContextSheetRow
 * (自带分组卡片、hairline 分隔、busy spinner)。
 *
 * 动作语义对齐桌面 chip 右键菜单(useFileChipContextMenu)的手机等价物:
 *   - 快速预览 / 打开文件浏览器:与 chip 点击同路;
 *   - 在文件浏览器中查看(仅文件):定位到父目录(桌面「打开文件所在目录」);
 *   - 发送到会话:@ 引用合入 composer 草稿(与文件浏览器同一实现);
 *   - 复制路径:远端原始绝对路径(桌面「复制文件路径」同语义);
 *   - 导出 / 分享(仅文件):两段式导出 → 系统分享单(与文件浏览器同链路)。
 */

import { Copy, Eye, FolderOpen, MessageSquarePlus, Share as ShareIcon } from 'lucide-react-native';
import { useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { ContextSheet, ContextSheetGroup, ContextSheetRow } from '@/session/ContextSheet';
import {
  chatFileChipMenuRows,
  chatFileChipMenuTitle,
  type ChatFileChipMenuActionKey,
} from '@/session/chatFileChipMenuModel';
import type { ChatFilePathTarget } from '@/session/chatFilePathContext';
import { iconSize, iconStroke } from '@/theme/tokens';
import { useTheme } from '@/theme';

export interface ChatFileChipMenuSheetProps {
  /** null = 关闭。 */
  target: ChatFilePathTarget | null;
  keyboardAvoidingBehavior: 'height' | 'padding' | undefined;
  onClose: () => void;
  /** 「导出 / 分享」进行中(行内 spinner,面板保持打开直到完成/失败)。 */
  shareBusy: boolean;
  onAction: (key: ChatFileChipMenuActionKey, target: ChatFilePathTarget) => void;
}

export function ChatFileChipMenuSheet({
  target,
  keyboardAvoidingBehavior,
  onClose,
  shareBusy,
  onAction,
}: ChatFileChipMenuSheetProps) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  // target 变 null 时不能立即卸载 Modal(会丢下拉收起动画,规则 7 视觉连续性)。
  // 与 ModelPickerSheet 同模式:visible 布尔驱动开/关动画,关闭动画期间用
  // 保留的最后一个非空 target 渲染内容。
  const lastTargetRef = useRef<ChatFilePathTarget | null>(null);
  if (target) lastTargetRef.current = target;
  const renderTarget = target ?? lastTargetRef.current;
  if (!renderTarget) return null;
  const iconProps = { color: colors.textSecondary, size: iconSize.md, strokeWidth: iconStroke.regular } as const;
  const iconOf = (key: ChatFileChipMenuActionKey) => {
    switch (key) {
      case 'open':
        return renderTarget.kind === 'directory' ? <FolderOpen {...iconProps} /> : <Eye {...iconProps} />;
      case 'revealInBrowser':
        return <FolderOpen {...iconProps} />;
      case 'sendToSession':
        return <MessageSquarePlus {...iconProps} />;
      case 'copyPath':
        return <Copy {...iconProps} />;
      case 'share':
        return <ShareIcon {...iconProps} />;
    }
  };
  return (
    <ContextSheet
      keyboardAvoidingBehavior={keyboardAvoidingBehavior}
      onClose={onClose}
      testID="session.chipMenu"
      title={chatFileChipMenuTitle(renderTarget)}
      visible={target != null}
    >
      <ContextSheetGroup label={renderTarget.kind === 'directory' ? t('composer.attachments.fileMenu.folder') : t('composer.attachments.fileMenu.file')}>
        {chatFileChipMenuRows(renderTarget).map((row) => (
          <ContextSheetRow
            busy={row.key === 'share' && shareBusy}
            icon={iconOf(row.key)}
            key={row.key}
            label={row.label}
            onPress={() => onAction(row.key, renderTarget)}
            testID={`session.chipMenu.${row.key}`}
          />
        ))}
      </ContextSheetGroup>
    </ContextSheet>
  );
}
