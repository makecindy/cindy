/**
 * git-context — 会话级 Git 分支感知 + PR 关联与实时状态(session-git-pr-context)。
 *
 * 模块组成:
 *   - headReader:fs 直读 .git/HEAD 的纯函数(分支 / detached / worktree 间接)
 *   - GitContextService:per-workdir HEAD watcher(经 watcher-host utility process)+ 变化广播
 *   - prRefExtractor:消息文本 → GitHub PR URL 确定性提取(纯函数)
 *   - prRefsStore:session_pr_refs 表读写,消息落库钩子在 localDb/ipc/messages.ts
 *   - prStatusService:GitHub API 查 PR 状态(60s TTL 缓存,无 PAT 优雅降级)
 *   - ipc:handler 注册与 Electron 依赖装配
 */

// 模块门面只暴露 bootstrap 实际消费的两个入口;channel 常量与钩子函数由
// 消费方直接 import 对应文件(messages.ts → prRefsStore 等),不经此处中转。
export { registerGitContextIpc, disposeGitContext } from './ipc.js';
