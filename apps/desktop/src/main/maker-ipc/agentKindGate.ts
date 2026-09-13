/**
 * IPC 入口的 agentKind 闸门。
 *
 * 两个口径必须分开:
 * - **会话面**(capabilities / 命令 / 技能 / @ 资源 / 定制 / 排队输入)认全部
 *   `AgentKind`,含本机可选 harness Grok Build —— 这些入口是会话能不能开口说话的
 *   前置,拒了 grok-build 会话就是死的。
 * - **New Maker 草稿面**认全部可选 harness(含 Grok Build):统一模型选择器
 *   把 grok-build 当第四个引擎选中后,GET_NEW_MAKER_DEFAULTS /
 *   APPLY_NEW_MAKER_DRAFT_PREF 必须能写回草稿槽。
 */

import type { AgentKind } from '@cindy/maker-core';

import { requireEnum } from '../utils/ipcValidate.js';

/**
 * 运行时枚举不能靠 TypeScript 强转替代,但也不该再手抄一份联合体:用
 * `Record<AgentKind, true>` 建表,`AgentKind` 新增成员时这里先编译不过,wire 闸门
 * 不会与类型声明漂移。
 */
const AGENT_KIND_KEYS: Record<AgentKind, true> = {
  'claude-code': true,
  codex: true,
  pi: true,
  'grok-build': true,
};

/** wire 上合法的全部 agent 种类。 */
export const AGENT_KINDS = Object.keys(AGENT_KIND_KEYS) as readonly AgentKind[];

/** 有 New Maker 草稿 vendor 槽的 agent(与 SELECTABLE_VENDORS 对齐)。 */
export const DRAFT_AGENT_KINDS = [
  'claude-code',
  'codex',
  'pi',
  'grok-build',
] as const satisfies readonly AgentKind[];

export type DraftAgentKind = (typeof DRAFT_AGENT_KINDS)[number];

/** 会话面 wire 入口的 agentKind 校验:认全部 AgentKind(含 Grok Build)。 */
export function requireAgentKind(value: unknown): AgentKind {
  return requireEnum(value, AGENT_KINDS, 'agentKind');
}

/**
 * 草稿面 wire 入口的 agentKind 校验:认全部可选 harness(含 Grok Build)。
 * `name` 供调用点保留自己的参数名(草稿 pref 的字段叫 `agent`)。
 */
export function requireDraftAgentKind(value: unknown, name = 'agentKind'): DraftAgentKind {
  return requireEnum(value, DRAFT_AGENT_KINDS, name);
}

/** 纯判定:给已有自己错误文案的调用点(如排队消息)做类型收窄。 */
export function isAgentKind(value: unknown): value is AgentKind {
  return typeof value === 'string' && (AGENT_KINDS as readonly string[]).includes(value);
}
