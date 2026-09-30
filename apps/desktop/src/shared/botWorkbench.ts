/** 伙伴工作台卡片:主进程存储与渲染层展示共用的数据形状。 */
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

export interface BotWorkbench {
  cards: BotWorkbenchCard[];
  updatedAt: string;
}
