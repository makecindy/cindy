export type GhostGrantLane =
  | 'attachments'
  | 'dir'
  | 'save_dir'
  | 'reveal_path'
  | 'fs_write'
  | 'workspace'
  | 'forge_source'
  | 'outside_workdir';

/** 确认卡上逐条展示的过户对象(路径/大小让用户看清自己在授权什么)。 */
export interface GhostGrantFileItem {
  /** 展示名(basename)。 */
  name: string;
  /** 完整绝对路径(用户须看到真实位置才叫知情授权)。 */
  absPath: string;
  /** 文件字节数;目录条目为收集后的总字节数。 */
  size: number;
  mimeType?: string;
  /** 图片的内嵌缩略预览(dataURL;非图片/超阈值缺省)。 */
  previewDataUrl?: string;
  isDirectory?: boolean;
  /** 目录条目:收集到的文件数。 */
  fileCount?: number;
}

export interface GhostGrantConfirmPayload {
  ghostId: string;
  /** 意识显示名(确认卡标题用;查不到时回落 id)。 */
  ghostName: string;
  lane: GhostGrantLane;
  items: GhostGrantFileItem[];
  /** 发起这次确认的工具名,确认卡用来写清具体副作用。 */
  sourceTool?: string;
  /** 这次授权对应的读写方向。 */
  operation?: 'read' | 'write';
}

export type GhostGrantConfirmDecision =
  | {
      confirmed: true;
      /**
       * attachments 通道的「目录级授权」勾选:用户允许的同时把 items 所在
       * 目录(精确父目录,不递归)记入会话级记忆,后续该目录下的媒体文件
       * 对该意识本会话内免弹。默认 false。
       */
      allowDirs?: boolean;
    }
  | { confirmed: false; reason: 'cancelled' | 'timeout' | 'session_closed' | 'session_aborted' };

