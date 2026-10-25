/**
 * 项目级定时任务配置文件的相对路径（相对 workingDir），main / renderer 共用的
 * 单一权威定义——main 侧 loader 与 renderer 侧"打开配置文件"必须拼出同一个文件。
 * 以路径段数组表达，由消费方自行选择分隔符（main 用 path.join，renderer 按
 * workingDir 里出现的分隔符拼接）。
 */
export const PROJECT_AUTOMATION_REL_SEGMENTS = [
  ".cindy",
  "automations",
  "schedules.json",
] as const;
