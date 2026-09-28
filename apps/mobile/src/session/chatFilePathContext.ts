/**
 * chatFilePathContext — 聊天正文文件 chip 的会话上下文(对齐桌面
 * ChatSessionFileContext 的心智:会话屏顶层 provide 一次,消息树内任意深度的
 * inline chip 直接消费,不经 MessageRenderer 的多层 prop 传递)。
 *
 * value 为 null 时(无 workdir / 无 deviceId / 非会话屏场景)chip 层整体退化为
 * 纯文本渲染,消费方无需特判。
 */

import { createContext } from 'react';

import type { RemotePathStatFn } from '@/session/remotePathVerdict';

/** chip 点击目标:文件 → Quick Look 预览页;目录 → 文件浏览器定位。 */
export interface ChatFilePathTarget {
  kind: 'file' | 'directory';
  /**
   * workdir 相对路径(POSIX 分隔,file-browser 全链路约定)。
   * null = workdir 外的文件(仅 kind='file' 会出现,预览/分享改走被控端
   * absPath 取件通道;workdir 外目录不点亮,不会成为 target)。
   */
  relPath: string | null;
  /** 被控端绝对路径(host-native;「复制路径」对齐桌面语义保留远端原始路径)。 */
  absPath: string;
  /** `foo.ts:42` 形态拆出的行号(仅文件预览用)。 */
  line?: number;
  /**
   * 路径所属的另一个任务(伙伴后台任务结果卡里的文件属于子任务);长按菜单的
   * 打开 / 定位 / 分享按它执行,缺省为当前会话。
   */
  scope?: { sessionId: string; workdir: string };
}

export interface ChatFilePathContextValue {
  deviceId: string;
  /** 当前会话 id；SSH 媒体取件由被控端据此反查可信 host/workdir。 */
  sessionId: string;
  /** 被控端会话 workdir(host-native 绝对路径,Windows 被控端为反斜杠形态)。 */
  workdir: string;
  /** SSH 会话的远端 host id；本地会话为空。媒体取件必须据此避免把远端路径当桌面本地路径。 */
  remoteHostId?: string;
  /** 远端 stat 执行体(会话屏包装 openLink + transport)。 */
  statPath: RemotePathStatFn;
  /** chip 点击导航(会话屏 router.push 到文件预览 / 文件浏览器)。 */
  onOpenPath: (target: ChatFilePathTarget) => void;
  /** chip 长按 → 会话屏呼出操作菜单(浮动面板);缺省无长按行为。 */
  onLongPressPath?: (target: ChatFilePathTarget) => void;
}

export const ChatFilePathContext = createContext<ChatFilePathContextValue | null>(null);
