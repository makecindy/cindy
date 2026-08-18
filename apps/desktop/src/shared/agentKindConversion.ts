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
export type DbAgentKind = 'cc' | 'codex' | 'pi' | 'dsh';
/** maker-core / IPC 契约侧的 agent 形态。 */
export type MakerAgentKindWire = 'claude-code' | 'codex' | 'pi' | 'dsh';

/** Runtime guard for the persisted sessions.agent_kind vocabulary. */
export function isDbAgentKind(value: unknown): value is DbAgentKind {
  return value === 'cc' || value === 'codex' || value === 'pi' || value === 'dsh';
}

/** Runtime guard for the Maker IPC agent-kind vocabulary. */
export function isMakerAgentKindWire(value: unknown): value is MakerAgentKindWire {
  return value === 'claude-code' || value === 'codex' || value === 'pi' || value === 'dsh';
}

export function dbToMakerAgentKind(db: string | null | undefined): MakerAgentKindWire {
  if (db === 'codex') return 'codex';
  if (db === 'pi') return 'pi';
  if (db === 'dsh') return 'dsh';
  return 'claude-code'; // 'cc' 与历史缺省
}

export function makerToDbAgentKind(maker: string | null | undefined): DbAgentKind {
  if (maker === 'codex') return 'codex';
  if (maker === 'pi') return 'pi';
  if (maker === 'dsh') return 'dsh';
  return 'cc'; // 'claude-code' 与历史缺省
}

/** 宽输入归一成 DbAgentKind;非法值回落 'cc'(与 sessions 表 default 同语义)。 */
export function normalizeDbAgentKind(value: string | null | undefined): DbAgentKind {
  return value === 'codex' || value === 'pi' || value === 'dsh' ? value : 'cc';
}
