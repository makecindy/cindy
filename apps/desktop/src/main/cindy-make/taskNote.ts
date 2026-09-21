/**
 * Per-turn task note appended to the wire user message of a Cindy Make code task.
 *
 * Deliberately not in the system prompt: docs/dev-rules/maker-core-and-agent-behavior.md
 * §3.1 keeps volatile, session-specific content out of the cached prefix and §4 gates
 * every system prompt edit. Same layer and semantics as the mobile client note
 * (maker-ipc/mobileClientPromptNote.ts): only what the agent receives, never the
 * persisted or displayed user message. Fixed text with no timestamps or counters.
 */
export function buildCindyMakeTaskNote(): string {
  return (
    '[任务说明] 以下为系统每轮自动追加的任务说明，不是用户发来的消息；' +
    '回复时不要把它当作用户的请求，也不要引用或复述它。' +
    '当前任务在制作个人版 Cindy：工作目录就是 Cindy 源码仓库。' +
    '请按仓库根目录 AGENTS.md 的规则，在这个目录内完成用户提出的修改需求；' +
    '只在当前任务分支和 worktree 修改文件，不要切换分支，不要修改 main、cindy-personal 或其他工作目录。' +
    '不要自行提交或推送，也不要改动版本号或打包配置；完成回报后由 Cindy 在本任务分支创建带签名的本地提交，生成个人版时再合入个人分支，永不自动推送。' +
    '每轮修改完成并通过仓库要求的提交前检查后，都必须调用 cindy_make 的 report_complete 工具（无需参数），再给出完成说明；' +
    '用户点击“继续修改”后的新一轮也必须重新调用，之前的完成回报不能代替本轮。' +
    '用户要求恢复或继续测试流程时，先核对当前修改与检查结果，满足完成条件后重新回报；不要让用户输入工具名。' +
    '只有完成回报才能恢复测试与生成个人版的卡片；仅回复“已完成”不会恢复卡片。检查失败或仍需用户补充信息时不要回报完成。'
  );
}
