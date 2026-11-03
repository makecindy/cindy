/**
 * 内置「跟进」例行任务的宿主指令模板(伙伴不能在设置页编辑)。
 *
 * 这是例行任务那一轮的用户侧指令,不是 system 段;事件 JSON 由例行任务服务附在其后的
 * 「不可信外部数据」块里,这里只引用它,不拼接事件内容。改动这里的措辞要同时递增
 * FOLLOW_UP_PROMPT_VERSION,宿主据此把已有伙伴的内置规则对齐到新模板。
 * 长度上限 1500 字:每次叫醒都会带上,控制成本。
 */
export const FOLLOW_UP_PROMPT_VERSION = 7;

export const FOLLOW_UP_PROMPT_MAX_CHARS = 1500;

export function buildFollowUpRoutinePrompt(_botId: string): string {
  // Host voice, not the owner's: this run is a Host wake-up and must not read as an owner request.
  // It is also the auto-review intent of the run, so it states the grant the owner switched on.
  return '主人开启了自动跟进；这一轮由宿主的任务事件唤醒，不是主人刚说的话。看看这些任务做得怎么样，有需要主人回复或决策的，给出你的判断和建议。已经交给你跟进的任务，可以让它按原来的目标接着做，或按摘要建议换模型；普通操作沿用当前任务权限；删除自动化、代答授权或恢复暂停等风险操作由宿主显示授权请求，等待主人决定，拒绝后不要重试。没有新情况就不用提醒。';
}
