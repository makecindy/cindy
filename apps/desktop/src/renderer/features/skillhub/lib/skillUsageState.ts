export interface SkillUsagePanelState {
  entryId: string | null;
  loading: boolean;
  error: string | null;
  summary: SkillUsageSummary | null;
}

export interface SkillUsageSummaryRequest {
  entryId: string;
  name: string;
  mdPath?: string;
  refreshNonce: number;
  dayKey: string;
}

export function buildUsageSummaryRequest(params: {
  entryId: string | null;
  name: string | null;
  mdPath: string | null;
  refreshNonce: number;
  dayKey: string;
}): SkillUsageSummaryRequest | null {
  if (!params.entryId || !params.name) return null;
  return {
    entryId: params.entryId,
    name: params.name,
    mdPath: params.mdPath ?? undefined,
    refreshNonce: params.refreshNonce,
    dayKey: params.dayKey,
  };
}

export function beginUsageSummaryRequest(
  previous: SkillUsagePanelState,
  entryId: string,
): SkillUsagePanelState {
  if (previous.entryId === entryId && previous.summary) {
    return {
      ...previous,
      loading: true,
      error: null,
    };
  }
  return {
    entryId,
    loading: true,
    error: null,
    summary: null,
  };
}

export function settleUsageSummarySuccess(
  previous: SkillUsagePanelState,
  entryId: string,
  result: { refreshing: boolean; hasSnapshot: boolean; summary: SkillUsageSummary },
): SkillUsagePanelState {
  return {
    entryId,
    loading: result.refreshing,
    error: null,
    summary: result.hasSnapshot
      ? result.summary
      : previous.entryId === entryId ? previous.summary : null,
  };
}

export function settleUsageSummaryFailure(
  previous: SkillUsagePanelState,
  entryId: string,
  error: string,
): SkillUsagePanelState {
  return {
    entryId,
    loading: false,
    error,
    summary: previous.entryId === entryId ? previous.summary : null,
  };
}
