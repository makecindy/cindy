/** 伙伴工作台:主进程存储与渲染层展示共用的数据形状。 */
export interface BotWorkbenchRow {
  title: string;
  detail?: string;
  flag?: boolean;
  status?: string;
  action?: { label: string; message: string };
}

export interface BotWorkbenchCard {
  title: string;
  source?: string;
  rows: BotWorkbenchRow[];
}

/**
 * 主人交给伙伴的工作目录。目录本身由宿主记录(选完立刻出现),
 * 分支、改动数、最近提交是读取时现算的事实,不落盘、不经过模型。
 */
export interface BotWorkbenchDirectory {
  path: string;
  name: string;
  addedAt: string;
  exists: boolean;
  git?: {
    branch: string | null;
    changes: number;
    lastCommit?: { subject: string; at: string };
  };
}

export interface BotWorkbench {
  /** 伙伴经 `update_workbench` 写入的卡片;为空表示伙伴还没整理过。 */
  cards: BotWorkbenchCard[];
  /** 最近一次写卡片的时间;从没写过为 null。 */
  updatedAt: string | null;
  directories: BotWorkbenchDirectory[];
}
