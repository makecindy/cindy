/**
 * 内置「跟进」例行任务的宿主指令模板(伙伴不能在设置页编辑)。
 *
 * 这是例行任务那一轮的用户侧指令,不是 system 段;事件 JSON 由例行任务服务附在其后的
 * 「不可信外部数据」块里,这里只引用它,不拼接事件内容。改动这里的措辞要同时递增
 * FOLLOW_UP_PROMPT_VERSION,宿主据此把已有伙伴的内置规则对齐到新模板。
 * 长度上限 1500 字:每次叫醒都会带上,控制成本。
 */
export const FOLLOW_UP_PROMPT_VERSION = 5;

export const FOLLOW_UP_PROMPT_MAX_CHARS = 1500;

export function buildFollowUpRoutinePrompt(_botId: string): string {
  return '看看这些任务做得怎么样，有什么需要我回复或决策的，给我你的判断和建议。没有新情况就不用提醒；未经我允许，不要给任务发消息或改变任务状态。';
}
