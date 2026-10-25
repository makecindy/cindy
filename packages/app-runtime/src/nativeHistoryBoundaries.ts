type DbAgentKind = 'cc'|'codex'|'pi';


export interface ParsedAgentSwitchBoundary {
  fromAgentKind: DbAgentKind;
  fromAgentDeviceId?: string | null;
  toAgentKind?: DbAgentKind;
  fromModel: string | null;
  fromProviderId?: string | null;
  toProviderId?: string | null;
  fromSdkSessionId: string | null;
  handoff?: string;
}
export interface CodexNativeBoundaryRow {role:string;content:string;agentMeta:string|null;createdAt:number;}


export function parseAgentSwitchBoundary(content: string): ParsedAgentSwitchBoundary | null {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (
      parsed.fromAgentKind !== 'cc' &&
      parsed.fromAgentKind !== 'codex' &&
      parsed.fromAgentKind !== 'pi'
    )
      return null;
    const toAgentKind =
      parsed.toAgentKind === 'cc' || parsed.toAgentKind === 'codex' || parsed.toAgentKind === 'pi'
        ? parsed.toAgentKind
        : undefined;
    return {
      fromAgentKind: parsed.fromAgentKind,
      ...(Object.hasOwn(parsed, 'fromAgentDeviceId')
        ? { fromAgentDeviceId: typeof parsed.fromAgentDeviceId === 'string' ? parsed.fromAgentDeviceId : null }
        : {}),
      toAgentKind,
      fromModel: typeof parsed.fromModel === 'string' ? parsed.fromModel : null,
      ...(Object.hasOwn(parsed, 'fromProviderId')
        ? {
            fromProviderId:
              typeof parsed.fromProviderId === 'string' ? parsed.fromProviderId : null,
          }
        : {}),
      ...(Object.hasOwn(parsed, 'toProviderId')
        ? {
            toProviderId: typeof parsed.toProviderId === 'string' ? parsed.toProviderId : null,
          }
        : {}),
      fromSdkSessionId:
        typeof parsed.fromSdkSessionId === 'string' && parsed.fromSdkSessionId
          ? parsed.fromSdkSessionId
          : null,
      handoff: typeof parsed.handoff === 'string' && parsed.handoff ? parsed.handoff : undefined,
    };
  } catch {
    return null;
  }
}


export function parseCodexNativeForkAnchor(raw: string | null): {
  sdkSessionId: string;
  turnId: string;
} | null {
  if (!raw) return null;
  try {
    const meta = JSON.parse(raw) as Record<string, unknown>;
    if (meta.turnCompleted !== true) return null;
    const anchor = meta.nativeForkAnchor;
    if (!anchor || typeof anchor !== 'object' || Array.isArray(anchor)) return null;
    const candidate = anchor as Record<string, unknown>;
    if (
      candidate.agentKind !== 'codex' ||
      candidate.kind !== 'turn' ||
      typeof candidate.sdkSessionId !== 'string' ||
      !candidate.sdkSessionId ||
      typeof candidate.id !== 'string' ||
      !candidate.id
    ) {
      return null;
    }
    return { sdkSessionId: candidate.sdkSessionId, turnId: candidate.id };
  } catch {
    return null;
  }
}


export function resolveCodexTurnAnchor(
  rows: CodexNativeBoundaryRow[],
  sourceSdkSessionId: string,
): string | undefined {
  let timelineSdkSessionId: string | null = sourceSdkSessionId;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (row.role === 'context_rebuild') {
      // 重建之后是新的原生线程;不能从更早片段借 turn 锚点。
      return undefined;
    }
    if (row.role === 'agent_switch') {
      timelineSdkSessionId = parseAgentSwitchBoundary(row.content)?.fromSdkSessionId ?? null;
      continue;
    }
    if (row.role === 'user' && timelineSdkSessionId === sourceSdkSessionId) {
      return undefined;
    }
    if (row.role !== 'assistant' || timelineSdkSessionId !== sourceSdkSessionId) continue;
    const anchor = parseCodexNativeForkAnchor(row.agentMeta);
    // The newest assistant in this native segment is the requested boundary.
    // If that row predates anchors, belongs to a failed turn, or is malformed,
    // fall back for the whole fork instead of silently truncating at an older turn.
    return anchor?.sdkSessionId === sourceSdkSessionId ? anchor.turnId : undefined;
  }
  return undefined;
}


export function resolveCodexForkEventTimestamp(rows: CodexNativeBoundaryRow[]): number | undefined {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i]!;
    // A new native segment has no event to anchor yet. Never borrow time from
    // an earlier engine or the host's handoff marker.
    if (row.role === 'agent_switch' || row.role === 'context_rebuild' || row.role === 'user') return undefined;
    // Error rows can be backdated to user.createdAt + 1; user persistence may
    // precede turn/start. Only actual model/tool output proves the turn began.
    if (['assistant', 'tool_use', 'tool_result', 'thinking'].includes(row.role)) {
      return row.createdAt;
    }
  }
  return undefined;
}


/**
 * rows 之内是否没有属于 sourceSdkSessionId 原生线程的 user 行,即目标是该线程的第一轮。
 * 归属判定与 resolveCodexTurnAnchor 一致:agent_switch 之前的片段属于其 fromSdkSessionId
 * (切回停泊线程时仍是同一条线程);最近的 context_rebuild 截断更早历史,重建前的
 * agent_switch 不能把归属设回当前线程。
 * 不可解析或没有 fromSdkSessionId 的 switch 视为归属不定,返回 false,调用方不得标记
 * rewindsToNativeThreadStart(与「判定不出就明确失败」的 fail-closed 契约一致)。
 * rows 必须完整覆盖当前时间线(/clear 之后的可见行 + context_rebuild 标记);窗口被截断时
 * 调用方不得据此判定。
 */
export function isCodexNativeThreadStart(
  rows: CodexNativeBoundaryRow[],
  sourceSdkSessionId: string,
): boolean {
  let timelineSdkSessionId: string | null = sourceSdkSessionId;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i]!;
    if (row.role === 'context_rebuild') {
      // 重建之后是新的原生线程;更早的 agent_switch 不能把归属设回当前线程。
      break;
    }
    if (row.role === 'agent_switch') {
      const owner = parseAgentSwitchBoundary(row.content)?.fromSdkSessionId;
      if (!owner) return false;
      timelineSdkSessionId = owner;
      continue;
    }
    if (row.role === 'user' && timelineSdkSessionId === sourceSdkSessionId) return false;
  }
  return true;
}