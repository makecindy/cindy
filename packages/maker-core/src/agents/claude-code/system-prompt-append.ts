// Maker 注入到 Claude Code CLI 系统提示词后面的引擎级追加内容。
// 通过 SDK 的 systemPrompt.append 字段拼接到 preset 之后，不会覆盖 CLI 默认 prompt。
//
// 真正的内容写在同目录的 system-prompt-append.md，vite 编译时通过 ?raw 内联为字符串。
//
// 当前 .md 是空的 —— 原有的产品级规则已于 2026-07-16 经 Lizi 确认清空（内部系统 MCP
// 路由随飞书等迁入意识(Ghost)体系、免责声明随产品对外化、mermaid 渲染规范与实时信息
// 查询一并移除）。host 层注入口保留：
//   apps/desktop/src/main/maker-host/host-system-prompt.md  (vendor-neutral；当前是两行
//   产品身份锚点：身份声明 + 源码仓库地址，让模型知道自己是 Cindy 及源码在哪)
//   apps/desktop/src/main/maker-host/claude-system-prompt.md (Claude host 专属；当前为空——
//   原「绘图走 art MCP」规则已删，画图路由交给意识(Ghost)触发体系)
// 由 host 通过 runtimeConfig.systemPrompt 注入，跟本常量在 startSession 拼成一段
// (拼接顺序见 ./index.ts 内 `systemPrompt: (() => { ... })()` 那段)。
//
// 只有当某条规则**仅在 Claude Code 引擎层生效**（如 CC SDK 协议细节、ToolSearch 行为
// 等真正不可移植到其他 vendor 的内容）时，才往 .md 里加。任何 vendor-neutral / 依赖
// 桌面端能力的规则一律放 host 层，避免再次出现两份 .md 字节级重复的局面。
import promptText from './system-prompt-append.md?raw';

export const SYSTEM_PROMPT_APPEND = promptText.trim();
