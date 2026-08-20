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
/** Session persistence accepts experimental harnesses without widening stable provider contracts. */
export type SessionDbAgentKind = DbAgentKind | 'trueforge';
export type SessionMakerAgentKindWire = MakerAgentKindWire | 'trueforge';

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

export function dbToSessionAgentKind(db: string | null | undefined): SessionMakerAgentKindWire {
  return db === 'trueforge' ? 'trueforge' : dbToMakerAgentKind(db);
}

export function sessionToDbAgentKind(maker: string | null | undefined): SessionDbAgentKind {
  return maker === 'trueforge' ? 'trueforge' : makerToDbAgentKind(maker);
}

export function normalizeSessionDbAgentKind(
  value: string | null | undefined,
): SessionDbAgentKind {
  return value === 'trueforge' ? 'trueforge' : normalizeDbAgentKind(value);
}
