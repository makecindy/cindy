/**
 * agentKindConversion —— DB/renderer 形态('cc' | 'codex' | 'pi')与 maker-core
 * 形态('claude-code' | 'codex' | 'pi')的唯一双向映射。
 *
 * 背景:sessions.agent_kind 历史上存 renderer 形态('cc' 起家,default 'cc'),
 * maker-core 用 'claude-code'。三值化前全仓散落 `x === 'cc' ? 'claude-code' :
 * 'codex'` 这类二元 ternary —— pi 进来后每一处都会把 pi 误判成另一家。
 * 一律改走本模块;新增 agent 只改这里。
 */

/** DB(sessions.agent_kind)与 renderer 侧的 agent 形态。 */
export type DbAgentKind = 'cc' | 'codex' | 'pi';
/** maker-core / IPC 契约侧的 agent 形态。 */
export type MakerAgentKindWire = 'claude-code' | 'codex' | 'pi';

export function dbToMakerAgentKind(db: string | null | undefined): MakerAgentKindWire {
  if (db === 'codex') return 'codex';
  if (db === 'pi') return 'pi';
  return 'claude-code'; // 'cc' 与历史缺省
}

export function makerToDbAgentKind(maker: string | null | undefined): DbAgentKind {
  if (maker === 'codex') return 'codex';
  if (maker === 'pi') return 'pi';
  return 'cc'; // 'claude-code' 与历史缺省
}

/** 宽输入归一成 DbAgentKind;非法值回落 'cc'(与 sessions 表 default 同语义)。 */
export function normalizeDbAgentKind(value: string | null | undefined): DbAgentKind {
  return value === 'codex' || value === 'pi' ? value : 'cc';
}

/**
 * 插件提供的 ACP 执行引擎（docs/dev-rules/acp-plugin-harness.md）。
 * 所有会接触第 4 种引擎（acp）的任务、界面、归因、调度、IM、Orca、远程与 MCP 路径一律使用
 * 下面的 Engine 版本与穷举分发函数，不要再退回三值函数把 acp 误判成 cc / claude-code。
 * 上面三个仅内置三引擎的函数只保留给明确限定内置引擎的目录与旧 wire 兼容层。
 */
export type DbEngineKind = DbAgentKind | 'acp';
export type MakerEngineKindWire = MakerAgentKindWire | 'acp';

export const ALL_DB_ENGINE_KINDS: readonly DbEngineKind[] = ['cc', 'codex', 'pi', 'acp'];
export const ALL_MAKER_ENGINE_KINDS: readonly MakerEngineKindWire[] = ['claude-code', 'codex', 'pi', 'acp'];

export function isDbEngineKind(value: unknown): value is DbEngineKind {
  return value === 'cc' || value === 'codex' || value === 'pi' || value === 'acp';
}

export function isMakerEngineKind(value: unknown): value is MakerEngineKindWire {
  return value === 'claude-code' || value === 'codex' || value === 'pi' || value === 'acp';
}

export function dbToMakerEngineKind(db: string | null | undefined): MakerEngineKindWire {
  return db === 'acp' ? 'acp' : dbToMakerAgentKind(db);
}

export function makerToDbEngineKind(maker: string | null | undefined): DbEngineKind {
  return maker === 'acp' ? 'acp' : makerToDbAgentKind(maker);
}

/** sessions.agent_kind 是否为插件引擎任务(DB 与 maker 形态同值)。 */
export function isPluginEngineKind(kind: string | null | undefined): kind is 'acp' {
  return kind === 'acp';
}

/** 编译期穷举 DbEngineKind（cc / codex / pi / acp），防止遗漏插件引擎或隐式回落 cc。 */
export function matchDbEngineKind<T>(kind: DbEngineKind, handlers: Readonly<Record<DbEngineKind, () => T>>): T {
  switch (kind) {
    case 'cc':
      return handlers.cc();
    case 'codex':
      return handlers.codex();
    case 'pi':
      return handlers.pi();
    case 'acp':
      return handlers.acp();
    default: {
      const unexpected: never = kind;
      throw new Error(`Unhandled DbEngineKind: ${String(unexpected)}`);
    }
  }
}

/** 编译期穷举 MakerEngineKindWire（claude-code / codex / pi / acp），防止遗漏插件引擎或隐式回落 Claude。 */
export function matchMakerEngineKind<T>(
  kind: MakerEngineKindWire,
  handlers: Readonly<Record<MakerEngineKindWire, () => T>>,
): T {
  switch (kind) {
    case 'claude-code':
      return handlers['claude-code']();
    case 'codex':
      return handlers.codex();
    case 'pi':
      return handlers.pi();
    case 'acp':
      return handlers.acp();
    default: {
      const unexpected: never = kind;
      throw new Error(`Unhandled MakerEngineKindWire: ${String(unexpected)}`);
    }
  }
}
