/**
 * 伙伴真技能的跨进程线型(main / preload / renderer 共用一份)。
 *
 * 磁盘事实与挂载逻辑在 `main/maker-ipc/botSkillStore.ts` 与 `botSkillService.ts`;
 * 这里只留设置页与 IPC 需要的那几个字段,不含技能目录的绝对路径 —— renderer
 * 不需要它,也不该拿到 userData 下的真实路径。
 */

/** 「TA 学会的」列表里的一条真技能。 */
export interface BotSkillSummary {
  /** 目录名,删除 / 展开正文时的稳定标识。 */
  slug: string;
  /** 展示名。 */
  name: string;
  /** 一句话:什么情况下该用它。可能为空(手写的技能)。 */
  description: string;
  /** ISO 串;解析不出来时为空串,由展示方降级成不显示时间。 */
  updatedAt: string;
}

/** 展开某条技能时额外带上正文。 */
export interface BotSkillDetail extends BotSkillSummary {
  body: string;
}
