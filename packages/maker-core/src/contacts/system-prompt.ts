/**
 * 智能通讯录 system prompt 段 — 两态注入, 注入点紧跟 makerMemoryRules。
 *
 * 真正内容在同目录两个 md, vite 编译时通过 ?raw 内联为字符串:
 *  - CONTACTS_RULES_ENABLED  (system-prompt-enabled.md): 开关开 — 使用规范
 *    (先 resolve 再写 / pending 语义 / 服从工具层 rules), 细则仍以 cindy_contacts
 *    工具 rules 字段为准, 本段只负责"让 agent 想起来用"。
 *  - CONTACTS_RULES_DISABLED (system-prompt-disabled.md): 开关关 — 让 agent 知道
 *    功能存在, 在三类场景下可提醒用户开启(每会话至多一次, 被拒不再提)。
 *
 * 使用方:
 *  - claude-code/index.ts startSession 拼 systemPrompt.append 时, host 注入了
 *    deps.getContactsPromptState 才注入(缺省 = 两段都不注入, 与改造前行为一致)
 *  - codex/index.ts 同上, 拼 developerInstructions
 *
 * 缓存约束(maker-core-and-agent-behavior.md §3.1): 开关状态与 MCP 工具注册
 * 同点求值(claude 每次 buildQuery, codex 每 session 一次), 单次 build 内文案
 * 恒定, 不进任何 per-turn 易变段; remote 会话不注入(工具不可达)。
 */

import enabledText from './system-prompt-enabled.md?raw';
import disabledText from './system-prompt-disabled.md?raw';

export const CONTACTS_RULES_ENABLED = enabledText.trim();
export const CONTACTS_RULES_DISABLED = disabledText.trim();

/**
 * host 计算的「本会话有效通讯录状态」(getContactsPromptState 返回值):
 *  - enabled     → 注入使用规范段(agent 侧还会与实际注册的工具面取交)
 *  - disabled    → 功能未开启, 注入「可选功能告示」段(邀请用户开启)
 *  - unavailable → 功能开着但本会话不可用(工作区/用户覆盖禁用、codex stale
 *                  spawn 快照等) — 什么都不注入: 既不能指挥模型用不可达的工具,
 *                  也不该邀请用户去开一个已经开着的开关。
 */
export type ContactsPromptState = 'enabled' | 'disabled' | 'unavailable';
