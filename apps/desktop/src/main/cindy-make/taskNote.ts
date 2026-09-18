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
    '修改完成并通过仓库要求的提交前检查后，必须调用 cindy_make 的 report_complete 工具并附改动说明；' +
    '这是向用户报告完成的唯一方式。'
  );
}
