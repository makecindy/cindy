import type Database from 'better-sqlite3';
import type { DbClient } from '../localDb/client/DbClient.js';

import {
  MIN_VERSION_COMPARISON_USE_COUNT,
  selectSkillUsageVersionComparison,
} from '../../shared/skillUsageComparison';
import type {
  SkillDocumentHashSource,
  SkillUsageAgentKind,
  SkillUsageAnalysisResult,
  SkillUsageExposureSource,
  SkillUsageObservation,
} from './usageAnalyzer';
import { RECENT_USAGE_WINDOW_DAYS, recentWindowStartMs } from './usageWindow';

export interface SkillUsageSourceRecord {
  rawFilePath: string;
  analyzerVersion: string;
  agentKind: SkillUsageAgentKind;
  sessionId: string;
  sdkSessionId: string;
  mtimeMs: number;
  sizeBytes: number;
  scannedAt: number;
}

export interface SkillUsageFailedSourceRecord {
  rawFilePath: string;
  analyzerVersion: string;
  agentKind: SkillUsageAgentKind;
  sessionId: string;
  sdkSessionId: string;
  mtimeMs: number;
  sizeBytes: number;
  scannedAt: number;
  error: string;
}

export interface SkillUsageRecentSourceRecord {
  rawFilePath: string;
  agentKind: SkillUsageAgentKind;
  sessionId: string;
  sdkSessionId: string;
}

export interface SkillUsageSourceBreakdown {
  strongActive: number;
  semiActive: number;
  passive: number;
}

export interface SkillUsageAgentBreakdown {
  claude: number;
  codex: number;
}

export interface SkillUsageReadObservation {
  fileReadCount: number;
  sessionsWithFileRead: number;
  averageFileReadsPerSession: number;
  extraFileReadCount: number;
  shortWindowRereadSessionCount: number;
  shortWindowRereadRate: number | null;
}

export interface SkillUsageDocumentSize {
  characterCount: number;
  byteCount: number;
  estimatedTokenCount: number;
}

export interface SkillUsageDocumentVersionSummary {
  skillDocumentHash: string;
  useCount: number;
  firstSeenAt: number;
  latestSeenAt: number;
  agentBreakdown: SkillUsageAgentBreakdown;
  sourceBreakdown: SkillUsageSourceBreakdown;
  readObservation: SkillUsageReadObservation;
  toolCallCount: number;
  repeatedToolCallCount: number;
  toolErrorCount: number;
  commandCallCount: number;
  commandFailureCount: number;
  averageToolCalls: number;
  averageRepeatedToolCalls: number;
  commandFailureRate: number | null;
}

export interface SkillUsageTrendPoint {
  day: string;
  useCount: number;
  averageToolCalls: number;
  averageRepeatedToolCalls: number;
  commandFailureRate: number | null;
}

export interface SkillUsageSummary {
  skillName: string;
  currentDocumentHash: string | null;
  totalUseCount: number;
  currentDocumentVersionUseCount: number;
  unversionedUseCount: number;
  documentVersionCoverageRate: number | null;
  latestSeenAt: number | null;
  agentBreakdown: SkillUsageAgentBreakdown;
  sourceBreakdown: SkillUsageSourceBreakdown;
  readObservation: SkillUsageReadObservation;
  currentDocumentSize: SkillUsageDocumentSize | null;
  documentVersions: SkillUsageDocumentVersionSummary[];
  currentDocumentVersion: SkillUsageDocumentVersionSummary | null;
  trend: SkillUsageTrendPoint[];
}

export interface SkillUsageQueryScope {
  skillName: string;
  currentDocumentHash?: string | null;
  currentDocumentContent?: string | null;
  analyzerVersion?: string | null;
  nowMs?: number;
}

const SHORT_WINDOW_REREAD_THRESHOLD = 3;
const SHORT_WINDOW_REREAD_WINDOW_MS = 30 * 60 * 1000;

export type SkillUsageEvidenceBucket =
  | 'tool_failed'
  | 'command_failed'
  | 'repeated_calls'
  | 'recent';

export interface SkillUsageEvidenceIndex {
  id: string;
  bucket: SkillUsageEvidenceBucket;
  rawFilePath: string;
  rawLineNo: number;
  sessionId: string;
  sdkSessionId: string;
  agentKind: SkillUsageAgentKind;
  skillName: string;
  skillPath: string | null;
  skillDocumentHash: string | null;
  exposureContentHash: string;
  documentHashSource: SkillDocumentHashSource | string;
  source: SkillUsageExposureSource | string;
  toolUseId: string | null;
  seenAt: number;
  observation: SkillUsageObservation;
}

export interface SkillUsageDiagnosisContext {
  skillName: string;
  skillPath: string | null;
  currentDocumentHash: string | null;
  summary: SkillUsageSummary;
  evidence: SkillUsageEvidenceIndex[];
  prompt: string;
}

export function persistSkillUsageAnalysis(
  db: Database.Database,
  source: SkillUsageSourceRecord,
  analysis: SkillUsageAnalysisResult,
): void {
  const upsertSource = db.prepare(`
    INSERT INTO skill_usage_sources (
      raw_file_path, analyzer_version, agent_kind, session_id, sdk_session_id,
      mtime_ms, size_bytes, last_scanned_at, status, error
    )
    VALUES (
      @rawFilePath, @analyzerVersion, @agentKind, @sessionId, @sdkSessionId,
      @mtimeMs, @sizeBytes, @scannedAt, 'ok', NULL
    )
    ON CONFLICT(raw_file_path) DO UPDATE SET
      analyzer_version = excluded.analyzer_version,
      agent_kind = excluded.agent_kind,
      session_id = excluded.session_id,
      sdk_session_id = excluded.sdk_session_id,
      mtime_ms = excluded.mtime_ms,
      size_bytes = excluded.size_bytes,
      last_scanned_at = excluded.last_scanned_at,
      status = 'ok',
      error = NULL
  `);
  const deleteExposure = db.prepare(`
    DELETE FROM skill_usage_exposures
    WHERE raw_file_path = ? AND analyzer_version = ?
  `);
  const insertExposure = db.prepare(`
    INSERT INTO skill_usage_exposures (
      id, analyzer_version, raw_file_path, raw_line_no, session_id, sdk_session_id, agent_kind,
      skill_name, skill_path, skill_document_hash, exposure_content_hash, document_hash_source,
      source, tool_use_id, seen_at,
      tool_call_count, repeated_tool_call_count, tool_error_count, command_call_count,
      command_failure_count
    )
    VALUES (
      @id, @analyzerVersion, @rawFilePath, @rawLineNo, @sessionId, @sdkSessionId, @agentKind,
      @skillName, @skillPath, @skillDocumentHash, @exposureContentHash, @documentHashSource,
      @source, @toolUseId, @seenAt,
      @toolCallCount, @repeatedToolCallCount, @toolErrorCount, @commandCallCount,
      @commandFailureCount
    )
  `);

  const tx = db.transaction(() => {
    upsertSource.run(source);
    deleteExposure.run(source.rawFilePath, source.analyzerVersion);
    for (const exposure of analysis.exposures) {
      insertExposure.run({
        id: `${source.analyzerVersion}:${exposure.id}`,
        analyzerVersion: source.analyzerVersion,
        rawFilePath: exposure.rawFilePath,
        rawLineNo: exposure.rawLineNo,
        sessionId: exposure.sessionId,
        sdkSessionId: exposure.sdkSessionId,
        agentKind: exposure.agentKind,
        skillName: exposure.skillName,
        skillPath: exposure.skillPath,
        skillDocumentHash: exposure.skillDocumentHash,
        exposureContentHash: exposure.exposureContentHash,
        documentHashSource: exposure.documentHashSource,
        source: exposure.source,
        toolUseId: exposure.toolUseId,
        seenAt: exposure.seenAt,
        toolCallCount: exposure.observation.toolCallCount,
        repeatedToolCallCount: exposure.observation.repeatedToolCallCount,
        toolErrorCount: exposure.observation.toolErrorCount,
        commandCallCount: exposure.observation.commandCallCount,
        commandFailureCount: exposure.observation.commandFailureCount,
      });
    }
  });

  tx();
}

export async function persistSkillUsageAnalysisWithClient(
  client: DbClient,
  source: SkillUsageSourceRecord,
  analysis: SkillUsageAnalysisResult,
): Promise<void> {
  await client.tx('skillUsage.applyMutation', {
    kind: 'persist',
    source,
    exposures: analysis.exposures.map((exposure) => ({
      id: exposure.id,
      rawFilePath: exposure.rawFilePath,
      rawLineNo: exposure.rawLineNo,
      sessionId: exposure.sessionId,
      sdkSessionId: exposure.sdkSessionId,
      agentKind: exposure.agentKind,
      skillName: exposure.skillName,
      skillPath: exposure.skillPath,
      skillDocumentHash: exposure.skillDocumentHash,
      exposureContentHash: exposure.exposureContentHash,
      documentHashSource: exposure.documentHashSource,
      source: exposure.source,
      toolUseId: exposure.toolUseId,
      seenAt: exposure.seenAt,
      toolCallCount: exposure.observation.toolCallCount,
      repeatedToolCallCount: exposure.observation.repeatedToolCallCount,
      toolErrorCount: exposure.observation.toolErrorCount,
      commandCallCount: exposure.observation.commandCallCount,
      commandFailureCount: exposure.observation.commandFailureCount,
    })),
  });
}

export function markSkillUsageSourceFailed(
  db: Database.Database,
  source: SkillUsageFailedSourceRecord,
): void {
  const upsertFailedSource = db.prepare(`
    INSERT INTO skill_usage_sources (
      raw_file_path, analyzer_version, agent_kind, session_id, sdk_session_id,
      mtime_ms, size_bytes, last_scanned_at, status, error
    )
    VALUES (
      @rawFilePath, @analyzerVersion, @agentKind, @sessionId, @sdkSessionId,
      @mtimeMs, @sizeBytes, @scannedAt, 'failed', @error
    )
    ON CONFLICT(raw_file_path) DO UPDATE SET
      analyzer_version = excluded.analyzer_version,
      agent_kind = excluded.agent_kind,
      session_id = excluded.session_id,
      sdk_session_id = excluded.sdk_session_id,
      mtime_ms = excluded.mtime_ms,
      size_bytes = excluded.size_bytes,
      last_scanned_at = excluded.last_scanned_at,
      status = 'failed',
      error = excluded.error
  `);
  const tx = db.transaction(() => {
    upsertFailedSource.run(source);
  });

  tx();
}

export async function markSkillUsageSourceFailedWithClient(
  client: DbClient,
  source: SkillUsageFailedSourceRecord,
): Promise<void> {
  await client.exec(`
    INSERT INTO skill_usage_sources (
      raw_file_path, analyzer_version, agent_kind, session_id, sdk_session_id,
      mtime_ms, size_bytes, last_scanned_at, status, error
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'failed', ?)
    ON CONFLICT(raw_file_path) DO UPDATE SET
      analyzer_version = excluded.analyzer_version,
      agent_kind = excluded.agent_kind,
      session_id = excluded.session_id,
      sdk_session_id = excluded.sdk_session_id,
      mtime_ms = excluded.mtime_ms,
      size_bytes = excluded.size_bytes,
      last_scanned_at = excluded.last_scanned_at,
      status = 'failed',
      error = excluded.error
  `, [
    source.rawFilePath, source.analyzerVersion, source.agentKind, source.sessionId,
    source.sdkSessionId, source.mtimeMs, source.sizeBytes, source.scannedAt, source.error,
  ]);
}

export function listSkillUsageSourcesWithRecentExposures(
  db: Database.Database,
  analyzerVersion: string,
  recentSince: number,
): SkillUsageRecentSourceRecord[] {
  const rows = db.prepare(`
    SELECT
      e.raw_file_path AS rawFilePath,
      e.agent_kind AS agentKind,
      e.session_id AS sessionId,
      e.sdk_session_id AS sdkSessionId
    FROM skill_usage_exposures e
    WHERE e.analyzer_version = ?
      AND e.seen_at >= ?
    GROUP BY e.raw_file_path
    ORDER BY MAX(e.seen_at) DESC
  `).all(analyzerVersion, recentSince) as Array<Record<string, unknown>>;

  return toRecentSourceRecords(rows);
}

export async function listSkillUsageSourcesWithRecentExposuresFromClient(
  client: DbClient,
  analyzerVersion: string,
  recentSince: number,
): Promise<SkillUsageRecentSourceRecord[]> {
  const rows = await client.query<Record<string, unknown>>(`
    SELECT
      e.raw_file_path AS rawFilePath,
      e.agent_kind AS agentKind,
      e.session_id AS sessionId,
      e.sdk_session_id AS sdkSessionId
    FROM skill_usage_exposures e
    WHERE e.analyzer_version = ?
      AND e.seen_at >= ?
    GROUP BY e.raw_file_path
    ORDER BY MAX(e.seen_at) DESC
  `, [analyzerVersion, recentSince]);
  return toRecentSourceRecords(rows);
}

export function deleteSkillUsageRecordsBefore(
  db: Database.Database,
  analyzerVersion: string,
  recentSince: number,
): void {
  const tx = db.transaction(() => {
    db.prepare(`
      DELETE FROM skill_usage_exposures
      WHERE analyzer_version = ?
        AND seen_at < ?
    `).run(analyzerVersion, recentSince);
    db.prepare(`
      DELETE FROM skill_usage_sources
      WHERE analyzer_version = ?
        AND mtime_ms < ?
        AND raw_file_path NOT IN (
          SELECT raw_file_path
          FROM skill_usage_exposures
        )
    `).run(analyzerVersion, recentSince);
  });

  tx();
}

export async function deleteSkillUsageRecordsBeforeWithClient(
  client: DbClient,
  analyzerVersion: string,
  recentSince: number,
): Promise<void> {
  await client.tx('skillUsage.applyMutation', { kind: 'deleteBefore', analyzerVersion, recentSince });
}

export async function promoteSkillUsageAnalyzerVersionWithClient(
  client: DbClient,
  analyzerVersion: string,
): Promise<void> {
  await client.tx('skillUsage.applyMutation', { kind: 'promote', analyzerVersion });
}

export function getSkillUsageSummaryFromDb(
  db: Database.Database,
  params: SkillUsageQueryScope,
): SkillUsageSummary {
  const analyzerVersion = params.analyzerVersion ?? null;
  const recentSince = recentWindowStartMs(params.nowMs ?? Date.now());
  const filter = skillUsageFilter(params.skillName, analyzerVersion, recentSince);
  const versionRows = db.prepare(`
    SELECT
      skill_document_hash AS skillDocumentHash,
      COUNT(*) AS useCount,
      MIN(seen_at) AS firstSeenAt,
      MAX(seen_at) AS latestSeenAt,
      SUM(CASE WHEN agent_kind = 'claude-code' THEN 1 ELSE 0 END) AS claudeUseCount,
      SUM(CASE WHEN agent_kind = 'codex' THEN 1 ELSE 0 END) AS codexUseCount,
      SUM(CASE WHEN source = 'claude_skill_tool' THEN 1 ELSE 0 END) AS strongActiveUseCount,
      SUM(CASE WHEN source IN ('claude_skill_file_read', 'codex_skill_file_read') THEN 1 ELSE 0 END) AS semiActiveUseCount,
      SUM(CASE
        WHEN source = 'claude_skill_tool' THEN 0
        WHEN source IN ('claude_skill_file_read', 'codex_skill_file_read') THEN 0
        ELSE 1
      END) AS passiveUseCount,
      SUM(tool_call_count) AS toolCallCount,
      SUM(repeated_tool_call_count) AS repeatedToolCallCount,
      SUM(tool_error_count) AS toolErrorCount,
      SUM(command_call_count) AS commandCallCount,
      SUM(command_failure_count) AS commandFailureCount
    FROM skill_usage_exposures
    WHERE ${filter.sql}
      AND skill_document_hash IS NOT NULL
    GROUP BY skill_document_hash
    ORDER BY latestSeenAt DESC
  `).all(...filter.params) as Array<Record<string, unknown>>;

  const totalRow = db.prepare(`
    SELECT
      COUNT(*) AS totalUseCount,
      MAX(seen_at) AS latestSeenAt,
      SUM(CASE WHEN agent_kind = 'claude-code' THEN 1 ELSE 0 END) AS claudeUseCount,
      SUM(CASE WHEN agent_kind = 'codex' THEN 1 ELSE 0 END) AS codexUseCount,
      SUM(CASE WHEN source = 'claude_skill_tool' THEN 1 ELSE 0 END) AS strongActiveUseCount,
      SUM(CASE WHEN source IN ('claude_skill_file_read', 'codex_skill_file_read') THEN 1 ELSE 0 END) AS semiActiveUseCount,
      SUM(CASE
        WHEN source = 'claude_skill_tool' THEN 0
        WHEN source IN ('claude_skill_file_read', 'codex_skill_file_read') THEN 0
        ELSE 1
      END) AS passiveUseCount,
      SUM(CASE WHEN skill_document_hash IS NULL THEN 1 ELSE 0 END) AS unversionedUseCount
    FROM skill_usage_exposures
    WHERE ${filter.sql}
  `).get(...filter.params) as Record<string, unknown> | undefined;

  const readObservations = getReadObservationsFromDb(db, params.skillName, analyzerVersion, recentSince);
  const trend = getSkillUsageTrendFromDb(db, params.skillName, analyzerVersion, recentSince);
  return buildSkillUsageSummary(params, versionRows, totalRow, readObservations, trend);
}

export async function getSkillUsageSummaryFromClient(
  client: DbClient,
  params: SkillUsageQueryScope,
): Promise<SkillUsageSummary> {
  const snapshot = await readSkillUsageSnapshotFromClient(client, params, false);
  return buildSkillUsageSummary(
    params,
    snapshot.versionRows,
    snapshot.totalRow,
    buildReadObservations(snapshot.readRows),
    snapshot.trendRows.map(toTrendPointFromRow),
  );
}

function buildSkillUsageSummary(
  params: SkillUsageQueryScope,
  versionRows: Array<Record<string, unknown>>,
  totalRow: Record<string, unknown> | undefined,
  readObservations: { overall: SkillUsageReadObservation; byVersion: Map<string, SkillUsageReadObservation> },
  trend: SkillUsageTrendPoint[],
): SkillUsageSummary {
  const documentVersions = versionRows.map((row) => toDocumentVersionSummary(row, readObservations.byVersion));
  const currentDocumentHash = params.currentDocumentHash ?? null;
  const totalUseCount = numberValue(totalRow?.totalUseCount);
  const unversionedUseCount = numberValue(totalRow?.unversionedUseCount);
  const versionedUseCount = totalUseCount - unversionedUseCount;
  const agentBreakdown = agentBreakdownFromRow(totalRow);
  const sourceBreakdown = sourceBreakdownFromRow(totalRow);
  const readObservation = readObservations.overall;
  const currentDocumentSize = params.currentDocumentContent === undefined || params.currentDocumentContent === null
    ? null
    : estimateDocumentSize(params.currentDocumentContent);
  const currentDocumentVersionUseCount = currentDocumentHash
    ? documentVersions.find((version) => version.skillDocumentHash === currentDocumentHash)?.useCount ?? 0
    : 0;
  const currentDocumentVersion = currentDocumentHash
    ? documentVersions.find((version) => version.skillDocumentHash === currentDocumentHash) ?? null
    : null;
  const latestSeenAt = totalUseCount > 0 ? numberValue(totalRow?.latestSeenAt) : null;
  return {
    skillName: params.skillName,
    currentDocumentHash,
    totalUseCount,
    currentDocumentVersionUseCount,
    unversionedUseCount,
    documentVersionCoverageRate: totalUseCount > 0 ? versionedUseCount / totalUseCount : null,
    latestSeenAt,
    agentBreakdown,
    sourceBreakdown,
    readObservation,
    currentDocumentSize,
    documentVersions,
    currentDocumentVersion,
    trend,
  };
}

function getReadObservationsFromDb(
  db: Database.Database,
  skillName: string,
  analyzerVersion: string | null,
  recentSince: number,
): { overall: SkillUsageReadObservation; byVersion: Map<string, SkillUsageReadObservation> } {
  const filter = skillUsageFilter(skillName, analyzerVersion, recentSince);
  const rows = db.prepare(`
    SELECT
      skill_document_hash AS skillDocumentHash,
      COALESCE(NULLIF(sdk_session_id, ''), session_id) AS sessionKey,
      seen_at AS seenAt
    FROM skill_usage_exposures
    WHERE ${filter.sql}
      AND source IN ('claude_skill_file_read', 'codex_skill_file_read')
    ORDER BY sessionKey ASC, seen_at ASC
  `).all(...filter.params) as Array<Record<string, unknown>>;
  return buildReadObservations(rows);
}

export function getSkillUsageDiagnosisContextFromDb(
  db: Database.Database,
  params: {
    skillName: string;
    currentDocumentHash?: string | null;
    currentDocumentContent?: string | null;
    analyzerVersion?: string | null;
    skillPath?: string | null;
    maxEvidence?: number;
    nowMs?: number;
  },
): SkillUsageDiagnosisContext {
  const summary = getSkillUsageSummaryFromDb(db, {
    skillName: params.skillName,
    currentDocumentHash: params.currentDocumentHash,
    currentDocumentContent: params.currentDocumentContent,
    analyzerVersion: params.analyzerVersion,
    nowMs: params.nowMs,
  });
  const currentDocumentHash = params.currentDocumentHash ?? null;
  const analyzerVersion = params.analyzerVersion ?? null;
  const recentSince = recentWindowStartMs(params.nowMs ?? Date.now());
  const evidenceHash = currentDocumentHash && summary.currentDocumentVersionUseCount > 0 ? currentDocumentHash : null;
  const evidence = selectDiagnosisEvidence(
    readEvidenceCandidates(db, params.skillName, evidenceHash, analyzerVersion, recentSince),
    params.maxEvidence ?? 12,
  );
  return {
    skillName: params.skillName,
    skillPath: params.skillPath ?? null,
    currentDocumentHash,
    summary,
    evidence,
    prompt: buildSkillUsageDiagnosisPrompt({
      skillName: params.skillName,
      skillPath: params.skillPath ?? null,
      summary,
      evidence,
    }),
  };
}

export async function getSkillUsageDiagnosisContextFromClient(
  client: DbClient,
  params: {
    skillName: string;
    currentDocumentHash?: string | null;
    currentDocumentContent?: string | null;
    analyzerVersion?: string | null;
    skillPath?: string | null;
    maxEvidence?: number;
    nowMs?: number;
  },
): Promise<SkillUsageDiagnosisContext> {
  const currentDocumentHash = params.currentDocumentHash ?? null;
  const snapshot = await readSkillUsageSnapshotFromClient(client, params, true);
  const summary = buildSkillUsageSummary(
    params,
    snapshot.versionRows,
    snapshot.totalRow,
    buildReadObservations(snapshot.readRows),
    snapshot.trendRows.map(toTrendPointFromRow),
  );
  const evidence = selectDiagnosisEvidence(
    snapshot.evidenceRows.map(toEvidenceIndex),
    params.maxEvidence ?? 12,
  );
  return {
    skillName: params.skillName,
    skillPath: params.skillPath ?? null,
    currentDocumentHash,
    summary,
    evidence,
    prompt: buildSkillUsageDiagnosisPrompt({
      skillName: params.skillName,
      skillPath: params.skillPath ?? null,
      summary,
      evidence,
    }),
  };
}

interface SkillUsageSnapshotRow {
  rowKind: 'version' | 'total' | 'read' | 'trend' | 'evidence';
  payload: string;
}

interface SkillUsageSnapshot {
  versionRows: Array<Record<string, unknown>>;
  totalRow: Record<string, unknown> | undefined;
  readRows: Array<Record<string, unknown>>;
  trendRows: Array<Record<string, unknown>>;
  evidenceRows: Array<Record<string, unknown>>;
}

/**
 * Read every derived view from one SQLite statement. The materialized CTE uses
 * the selective skill/version/time index once, and all aggregates observe the
 * same snapshot even when a background refresh is queued on the DB worker.
 */
async function readSkillUsageSnapshotFromClient(
  client: DbClient,
  params: SkillUsageQueryScope,
  includeEvidence: boolean,
): Promise<SkillUsageSnapshot> {
  const analyzerVersion = params.analyzerVersion ?? null;
  const recentSince = recentWindowStartMs(params.nowMs ?? Date.now());
  const filter = skillUsageFilter(params.skillName, analyzerVersion, recentSince);
  const currentDocumentHash = params.currentDocumentHash ?? null;
  const evidenceHash = currentDocumentHash || null;
  const evidenceCte = includeEvidence
    ? `,
      evidence_rows AS (
        SELECT *
        FROM filtered
        WHERE ${evidenceHash === null
          ? '1 = 1'
          : `(
            NOT EXISTS (
              SELECT 1 FROM filtered WHERE skill_document_hash = ?
            )
            OR skill_document_hash = ?
          )`}
        ORDER BY seen_at DESC
        LIMIT 500
      )`
    : '';
  const evidenceSelect = includeEvidence
    ? `
      UNION ALL
      SELECT 'evidence', json_object(
        'id', id,
        'rawFilePath', raw_file_path,
        'rawLineNo', raw_line_no,
        'sessionId', session_id,
        'sdkSessionId', sdk_session_id,
        'agentKind', agent_kind,
        'skillName', skill_name,
        'skillPath', skill_path,
        'skillDocumentHash', skill_document_hash,
        'exposureContentHash', exposure_content_hash,
        'documentHashSource', document_hash_source,
        'source', source,
        'toolUseId', tool_use_id,
        'seenAt', seen_at,
        'toolCallCount', tool_call_count,
        'repeatedToolCallCount', repeated_tool_call_count,
        'toolErrorCount', tool_error_count,
        'commandCallCount', command_call_count,
        'commandFailureCount', command_failure_count
      )
      FROM evidence_rows`
    : '';
  const queryParams = evidenceHash !== null && includeEvidence
    ? [...filter.params, evidenceHash, evidenceHash]
    : filter.params;
  const rows = await client.query<SkillUsageSnapshotRow>(`
    WITH filtered AS MATERIALIZED (
      SELECT *
      FROM skill_usage_exposures
      WHERE ${filter.sql}
    ),
    version_rows AS (
      SELECT
        skill_document_hash AS skillDocumentHash,
        COUNT(*) AS useCount,
        MIN(seen_at) AS firstSeenAt,
        MAX(seen_at) AS latestSeenAt,
        SUM(CASE WHEN agent_kind = 'claude-code' THEN 1 ELSE 0 END) AS claudeUseCount,
        SUM(CASE WHEN agent_kind = 'codex' THEN 1 ELSE 0 END) AS codexUseCount,
        SUM(CASE WHEN source = 'claude_skill_tool' THEN 1 ELSE 0 END) AS strongActiveUseCount,
        SUM(CASE WHEN source IN ('claude_skill_file_read', 'codex_skill_file_read') THEN 1 ELSE 0 END) AS semiActiveUseCount,
        SUM(CASE
          WHEN source = 'claude_skill_tool' THEN 0
          WHEN source IN ('claude_skill_file_read', 'codex_skill_file_read') THEN 0
          ELSE 1
        END) AS passiveUseCount,
        SUM(tool_call_count) AS toolCallCount,
        SUM(repeated_tool_call_count) AS repeatedToolCallCount,
        SUM(tool_error_count) AS toolErrorCount,
        SUM(command_call_count) AS commandCallCount,
        SUM(command_failure_count) AS commandFailureCount
      FROM filtered
      WHERE skill_document_hash IS NOT NULL
      GROUP BY skill_document_hash
    ),
    total_row AS (
      SELECT
        COUNT(*) AS totalUseCount,
        MAX(seen_at) AS latestSeenAt,
        SUM(CASE WHEN agent_kind = 'claude-code' THEN 1 ELSE 0 END) AS claudeUseCount,
        SUM(CASE WHEN agent_kind = 'codex' THEN 1 ELSE 0 END) AS codexUseCount,
        SUM(CASE WHEN source = 'claude_skill_tool' THEN 1 ELSE 0 END) AS strongActiveUseCount,
        SUM(CASE WHEN source IN ('claude_skill_file_read', 'codex_skill_file_read') THEN 1 ELSE 0 END) AS semiActiveUseCount,
        SUM(CASE
          WHEN source = 'claude_skill_tool' THEN 0
          WHEN source IN ('claude_skill_file_read', 'codex_skill_file_read') THEN 0
          ELSE 1
        END) AS passiveUseCount,
        SUM(CASE WHEN skill_document_hash IS NULL THEN 1 ELSE 0 END) AS unversionedUseCount
      FROM filtered
    ),
    read_rows AS (
      SELECT
        skill_document_hash AS skillDocumentHash,
        COALESCE(NULLIF(sdk_session_id, ''), session_id) AS sessionKey,
        seen_at AS seenAt
      FROM filtered
      WHERE source IN ('claude_skill_file_read', 'codex_skill_file_read')
    ),
    trend_rows AS (
      SELECT
        strftime('%Y-%m-%d', seen_at / 1000, 'unixepoch', 'localtime') AS day,
        COUNT(*) AS useCount,
        SUM(tool_call_count) AS toolCallCount,
        SUM(repeated_tool_call_count) AS repeatedToolCallCount,
        SUM(command_call_count) AS commandCallCount,
        SUM(command_failure_count) AS commandFailureCount
      FROM filtered
      GROUP BY day
      ORDER BY day DESC
      LIMIT 30
    )${evidenceCte}
    SELECT 'version' AS rowKind, json_object(
      'skillDocumentHash', skillDocumentHash,
      'useCount', useCount,
      'firstSeenAt', firstSeenAt,
      'latestSeenAt', latestSeenAt,
      'claudeUseCount', claudeUseCount,
      'codexUseCount', codexUseCount,
      'strongActiveUseCount', strongActiveUseCount,
      'semiActiveUseCount', semiActiveUseCount,
      'passiveUseCount', passiveUseCount,
      'toolCallCount', toolCallCount,
      'repeatedToolCallCount', repeatedToolCallCount,
      'toolErrorCount', toolErrorCount,
      'commandCallCount', commandCallCount,
      'commandFailureCount', commandFailureCount
    ) AS payload
    FROM version_rows
    UNION ALL
    SELECT 'total', json_object(
      'totalUseCount', totalUseCount,
      'latestSeenAt', latestSeenAt,
      'claudeUseCount', claudeUseCount,
      'codexUseCount', codexUseCount,
      'strongActiveUseCount', strongActiveUseCount,
      'semiActiveUseCount', semiActiveUseCount,
      'passiveUseCount', passiveUseCount,
      'unversionedUseCount', unversionedUseCount
    )
    FROM total_row
    UNION ALL
    SELECT 'read', json_object(
      'skillDocumentHash', skillDocumentHash,
      'sessionKey', sessionKey,
      'seenAt', seenAt
    )
    FROM read_rows
    UNION ALL
    SELECT 'trend', json_object(
      'day', day,
      'useCount', useCount,
      'toolCallCount', toolCallCount,
      'repeatedToolCallCount', repeatedToolCallCount,
      'commandCallCount', commandCallCount,
      'commandFailureCount', commandFailureCount
    )
    FROM trend_rows
    ${evidenceSelect}
  `, queryParams);

  const snapshot: SkillUsageSnapshot = {
    versionRows: [],
    totalRow: undefined,
    readRows: [],
    trendRows: [],
    evidenceRows: [],
  };
  for (const row of rows) {
    const payload = parseSkillUsageSnapshotPayload(row.payload);
    switch (row.rowKind) {
      case 'version':
        snapshot.versionRows.push(payload);
        break;
      case 'total':
        snapshot.totalRow = payload;
        break;
      case 'read':
        snapshot.readRows.push(payload);
        break;
      case 'trend':
        snapshot.trendRows.push(payload);
        break;
      case 'evidence':
        snapshot.evidenceRows.push(payload);
        break;
    }
  }
  snapshot.versionRows.sort((a, b) => numberValue(b.latestSeenAt) - numberValue(a.latestSeenAt));
  snapshot.trendRows.sort((a, b) => stringValue(b.day).localeCompare(stringValue(a.day)));
  return snapshot;
}

function parseSkillUsageSnapshotPayload(payload: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(payload);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('invalid skill usage snapshot payload');
  }
  return parsed as Record<string, unknown>;
}

function getSkillUsageTrendFromDb(
  db: Database.Database,
  skillName: string,
  analyzerVersion: string | null,
  recentSince: number,
): SkillUsageTrendPoint[] {
  const filter = skillUsageFilter(skillName, analyzerVersion, recentSince);
  const rows = db.prepare(`
    SELECT
      strftime('%Y-%m-%d', seen_at / 1000, 'unixepoch', 'localtime') AS day,
      COUNT(*) AS useCount,
      SUM(tool_call_count) AS toolCallCount,
      SUM(repeated_tool_call_count) AS repeatedToolCallCount,
      SUM(command_call_count) AS commandCallCount,
      SUM(command_failure_count) AS commandFailureCount
    FROM skill_usage_exposures
    WHERE ${filter.sql}
    GROUP BY day
    ORDER BY day DESC
    LIMIT 30
  `).all(...filter.params) as Array<Record<string, unknown>>;
  return rows.map(toTrendPointFromRow);
}

function readEvidenceCandidates(
  db: Database.Database,
  skillName: string,
  skillDocumentHash: string | null,
  analyzerVersion: string | null,
  recentSince: number,
): SkillUsageEvidenceIndex[] {
  const filter = skillUsageEvidenceFilter(skillName, skillDocumentHash, analyzerVersion, recentSince);
  const rows = db.prepare(`
    SELECT
      id,
      raw_file_path AS rawFilePath,
      raw_line_no AS rawLineNo,
      session_id AS sessionId,
      sdk_session_id AS sdkSessionId,
      agent_kind AS agentKind,
      skill_name AS skillName,
      skill_path AS skillPath,
      skill_document_hash AS skillDocumentHash,
      exposure_content_hash AS exposureContentHash,
      document_hash_source AS documentHashSource,
      source,
      tool_use_id AS toolUseId,
      seen_at AS seenAt,
      tool_call_count AS toolCallCount,
      repeated_tool_call_count AS repeatedToolCallCount,
      tool_error_count AS toolErrorCount,
      command_call_count AS commandCallCount,
      command_failure_count AS commandFailureCount
    FROM skill_usage_exposures
    WHERE ${filter.sql}
    ORDER BY seen_at DESC
    LIMIT 500
  `).all(...filter.params) as Array<Record<string, unknown>>;
  return rows.map(toEvidenceIndex);
}

function toEvidenceIndex(row: Record<string, unknown>): SkillUsageEvidenceIndex {
  return {
    id: stringValue(row.id),
    bucket: 'recent',
    rawFilePath: stringValue(row.rawFilePath),
    rawLineNo: numberValue(row.rawLineNo),
    sessionId: stringValue(row.sessionId),
    sdkSessionId: stringValue(row.sdkSessionId),
    agentKind: stringValue(row.agentKind) === 'claude-code' ? 'claude-code' : stringValue(row.agentKind) === 'pi' ? 'pi' : 'codex',
    skillName: stringValue(row.skillName),
    skillPath: stringValue(row.skillPath) || null,
    skillDocumentHash: stringValue(row.skillDocumentHash) || null,
    exposureContentHash: stringValue(row.exposureContentHash),
    documentHashSource: stringValue(row.documentHashSource),
    source: stringValue(row.source),
    toolUseId: stringValue(row.toolUseId) || null,
    seenAt: numberValue(row.seenAt),
    observation: {
      toolCallCount: numberValue(row.toolCallCount),
      repeatedToolCallCount: numberValue(row.repeatedToolCallCount),
      toolErrorCount: numberValue(row.toolErrorCount),
      commandCallCount: numberValue(row.commandCallCount),
      commandFailureCount: numberValue(row.commandFailureCount),
    },
  };
}

function selectDiagnosisEvidence(
  candidates: SkillUsageEvidenceIndex[],
  maxEvidence: number,
): SkillUsageEvidenceIndex[] {
  const limit = Math.max(1, Math.min(maxEvidence, 20));
  const perBucketLimit = Math.max(1, Math.ceil(limit / EVIDENCE_BUCKETS.length));
  const selected: SkillUsageEvidenceIndex[] = [];
  const selectedIds = new Set<string>();
  const selectedSessionKeys = new Set<string>();
  const selectedMetricKeys = new Set<string>();

  for (const bucket of EVIDENCE_BUCKETS) {
    const matches = candidates
      .filter((item) => !selectedIds.has(item.id) && bucket.match(item))
      .sort(bucket.compare);
    let bucketCount = 0;
    for (const item of matches) {
      if (selected.length >= limit) return selected;
      if (bucketCount >= perBucketLimit) break;
      const sessionKey = item.sdkSessionId || item.sessionId || item.id;
      const metricKey = evidenceMetricSignature(item);
      if (selectedSessionKeys.has(sessionKey) || selectedMetricKeys.has(metricKey)) continue;
      selected.push({ ...item, bucket: bucket.id });
      selectedIds.add(item.id);
      selectedSessionKeys.add(sessionKey);
      selectedMetricKeys.add(metricKey);
      bucketCount += 1;
    }
  }

  return selected;
}

function evidenceMetricSignature(item: SkillUsageEvidenceIndex): string {
  const observation = item.observation;
  return [
    item.agentKind,
    item.source,
    item.skillDocumentHash ?? '',
    item.documentHashSource,
    observation.toolCallCount,
    observation.repeatedToolCallCount,
    observation.toolErrorCount,
    observation.commandCallCount,
    observation.commandFailureCount,
  ].join(':');
}

const EVIDENCE_BUCKETS: Array<{
  id: SkillUsageEvidenceBucket;
  match: (item: SkillUsageEvidenceIndex) => boolean;
  compare: (a: SkillUsageEvidenceIndex, b: SkillUsageEvidenceIndex) => number;
}> = [
    {
      id: 'tool_failed',
      match: (item) => item.observation.toolErrorCount > item.observation.commandFailureCount,
      compare: (a, b) =>
        byNumberDesc(a.observation.toolErrorCount, b.observation.toolErrorCount) || byNumberDesc(a.seenAt, b.seenAt),
    },
    {
      id: 'command_failed',
      match: (item) => item.observation.commandFailureCount > 0,
      compare: (a, b) =>
        byNumberDesc(a.observation.commandFailureCount, b.observation.commandFailureCount) || byNumberDesc(a.seenAt, b.seenAt),
    },
    {
      id: 'repeated_calls',
      match: (item) => item.observation.repeatedToolCallCount > 0,
      compare: (a, b) =>
        byNumberDesc(a.observation.repeatedToolCallCount, b.observation.repeatedToolCallCount) ||
        byNumberDesc(a.seenAt, b.seenAt),
    },
    {
      id: 'recent',
      match: () => true,
      compare: (a, b) => byNumberDesc(a.seenAt, b.seenAt),
    },
  ];

function buildSkillUsageDiagnosisPrompt(params: {
  skillName: string;
  skillPath: string | null;
  summary: SkillUsageSummary;
  evidence: SkillUsageEvidenceIndex[];
}): string {
  const stats = buildPromptStats(params.summary);
  const evidenceIndexes = params.evidence.map((item) => ({
    bucket: item.bucket,
    rawFilePath: item.rawFilePath,
    rawLineNo: item.rawLineNo,
    sessionId: item.sessionId,
    sdkSessionId: item.sdkSessionId,
    agentKind: item.agentKind,
    source: item.source,
    skillDocumentHash: item.skillDocumentHash,
    exposureContentHash: item.exposureContentHash,
    documentHashSource: item.documentHashSource,
    seenAt: toIsoString(item.seenAt),
    observation: item.observation,
  }));

  return [
    `请诊断 Skill「${params.skillName}」的实际使用表现。`,
    '',
    '边界：',
    '- 不要修改任何文件；先读取证据并给出诊断。',
    '- 读取目标 skillPath 指向的 SKILL.md；如果 skillPath 为空或不可读，说明缺少文档证据。',
    '- 不要猜测用户意图；读取每条 rawFilePath 中 rawLineNo 附近上下文。',
    '- rawFilePath/rawLineNo 是证据入口，不是结论；读取失败时说明证据文件不可读，不要猜。',
    '- source/file_read 只表示模型接触过文档，不证明后续行为由 skill 导致。',
    `- 统计摘要和原始会话索引只覆盖最近 ${RECENT_USAGE_WINDOW_DAYS} 天，不代表历史全量。`,
    '- 诊断结论需要区分：skill 内容问题、任务复杂度问题、环境/工具问题、agent 行为问题。',
    '- 工具失败、命令失败、重复调用都是过程摩擦信号，不要直接当成最终成功率或质量分。',
    '- 不建议改 skill 也是有效结论；但必须把排除原因告诉用户，让用户知道问题更可能在哪。',
    '',
    '目标 Skill：',
    JSON.stringify({
      name: params.skillName,
      skillPath: params.skillPath,
    }, null, 2),
    '',
    '统计摘要：',
    JSON.stringify(stats, null, 2),
    '',
    '原始会话索引：',
    JSON.stringify(evidenceIndexes, null, 2),
    '',
    '读取 skillPath 指向的 SKILL.md，再读取每条 rawFilePath 中 rawLineNo 附近上下文，然后输出诊断报告：',
    '1. 结论：只允许用「建议改 skill」「暂不建议改 skill」「证据不足」之一开头。',
    '2. 已读取证据：列出 SKILL.md 和读取过的 rawFilePath:rawLineNo；读取失败也要列出。',
    '3. 为什么：说明证据覆盖了哪些问题模式，并判断工具失败、命令失败、重复调用是否被后续动作恢复或解释。',
    '4. 排除原因：即使暂不建议改 skill，也要说明用户接下来该看什么；适用时覆盖环境 / 权限 / 依赖问题、任务复杂度、工具失败或命令失败、agent 自行选择、source/file_read 无因果证据、样本太少。',
    '5. 归因：按 skill 内容问题、任务复杂度、环境/工具问题、agent 行为问题、用户偏好变化、证据不足分类，并给出对应证据。',
    '6. 如果证据支持改 skill，给出最小改动方向和原因；如果不支持，明确说暂不建议改，并给出非 skill 的下一步排查方向。',
  ].join('\n');
}

function buildPromptStats(summary: SkillUsageSummary): Record<string, unknown> {
  const current = summary.currentDocumentVersion;
  return {
    observationWindowDays: RECENT_USAGE_WINDOW_DAYS,
    totalUseCount: summary.totalUseCount,
    currentDocumentVersionUseCount: summary.currentDocumentVersionUseCount,
    latestSeenAt: summary.latestSeenAt ? toIsoString(summary.latestSeenAt) : null,
    readObservation: summary.readObservation,
    currentDocumentSize: summary.currentDocumentSize,
    currentDocumentVersion: current
      ? {
        useCount: current.useCount,
        readObservation: current.readObservation,
        processMetrics: buildPromptProcessMetrics(current),
      }
      : null,
    versionComparison: buildPromptVersionComparison(summary),
    trend: summary.trend,
  };
}

function buildPromptProcessMetrics(version: SkillUsageDocumentVersionSummary): Record<string, unknown> {
  if (version.useCount < MIN_VERSION_COMPARISON_USE_COUNT) {
    return {
      status: 'insufficient_sample',
      minUseCount: MIN_VERSION_COMPARISON_USE_COUNT,
      useCount: version.useCount,
    };
  }
  return {
    status: 'sampled',
    useCount: version.useCount,
    averageToolCalls: version.averageToolCalls,
    averageRepeatedToolCalls: version.averageRepeatedToolCalls,
    commandFailureRate: version.commandFailureRate,
  };
}

function buildPromptVersionComparison(summary: SkillUsageSummary): Record<string, unknown> {
  const comparison = selectSkillUsageVersionComparison(summary);
  if (comparison.status === 'no_current') {
    return {
      status: 'no_current',
      minUseCount: MIN_VERSION_COMPARISON_USE_COUNT,
    };
  }
  if (comparison.status === 'no_previous') {
    return {
      status: 'no_previous',
      minUseCount: MIN_VERSION_COMPARISON_USE_COUNT,
      currentUseCount: comparison.current.useCount,
    };
  }
  if (comparison.status === 'current_low_sample') {
    return {
      status: 'current_low_sample',
      minUseCount: MIN_VERSION_COMPARISON_USE_COUNT,
      currentUseCount: comparison.current.useCount,
      previousUseCount: comparison.previous.useCount,
    };
  }
  if (comparison.status === 'previous_low_sample') {
    return {
      status: 'previous_low_sample',
      minUseCount: MIN_VERSION_COMPARISON_USE_COUNT,
      currentUseCount: comparison.current.useCount,
      previousUseCount: comparison.previous.useCount,
    };
  }
  return {
    status: 'comparable',
    minUseCount: MIN_VERSION_COMPARISON_USE_COUNT,
    currentUseCount: comparison.current.useCount,
    previousUseCount: comparison.previous.useCount,
    averageToolCallsDelta: comparison.averageToolCallsDelta,
    averageRepeatedToolCallsDelta: comparison.averageRepeatedToolCallsDelta,
    commandFailureRateDelta: comparison.commandFailureRateDelta,
  };
}

function byNumberDesc(a: number, b: number): number {
  return b - a;
}

function byNumberAsc(a: number, b: number): number {
  return a - b;
}

function toIsoString(timestamp: number): string | null {
  if (!timestamp) return null;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function toDocumentVersionSummary(
  row: Record<string, unknown>,
  readObservationByVersion: Map<string, SkillUsageReadObservation>,
): SkillUsageDocumentVersionSummary {
  const skillDocumentHash = stringValue(row.skillDocumentHash);
  const summary = {
    skillDocumentHash,
    useCount: numberValue(row.useCount),
    firstSeenAt: numberValue(row.firstSeenAt),
    latestSeenAt: numberValue(row.latestSeenAt),
    agentBreakdown: agentBreakdownFromRow(row),
    sourceBreakdown: sourceBreakdownFromRow(row),
    readObservation: readObservationByVersion.get(skillDocumentHash) ?? createEmptyReadObservation(),
    toolCallCount: numberValue(row.toolCallCount),
    repeatedToolCallCount: numberValue(row.repeatedToolCallCount),
    toolErrorCount: numberValue(row.toolErrorCount),
    commandCallCount: numberValue(row.commandCallCount),
    commandFailureCount: numberValue(row.commandFailureCount),
  };
  return addDerivedMetrics(summary);
}

function toTrendPointFromRow(row: Record<string, unknown>): SkillUsageTrendPoint {
  return toTrendPoint({
    day: stringValue(row.day),
    useCount: numberValue(row.useCount),
    toolCallCount: numberValue(row.toolCallCount),
    repeatedToolCallCount: numberValue(row.repeatedToolCallCount),
    commandCallCount: numberValue(row.commandCallCount),
    commandFailureCount: numberValue(row.commandFailureCount),
  });
}

function toTrendPoint(raw: {
  day: string;
  useCount: number;
  toolCallCount: number;
  repeatedToolCallCount: number;
  commandCallCount: number;
  commandFailureCount: number;
}): SkillUsageTrendPoint {
  return {
    day: raw.day,
    useCount: raw.useCount,
    averageToolCalls: average(raw.toolCallCount, raw.useCount),
    averageRepeatedToolCalls: average(raw.repeatedToolCallCount, raw.useCount),
    commandFailureRate: rate(raw.commandFailureCount, raw.commandCallCount),
  };
}

function addDerivedMetrics(summary: Omit<
  SkillUsageDocumentVersionSummary,
  'averageToolCalls' | 'averageRepeatedToolCalls' | 'commandFailureRate'
>): SkillUsageDocumentVersionSummary {
  return {
    ...summary,
    averageToolCalls: average(summary.toolCallCount, summary.useCount),
    averageRepeatedToolCalls: average(summary.repeatedToolCallCount, summary.useCount),
    commandFailureRate: rate(summary.commandFailureCount, summary.commandCallCount),
  };
}

function average(total: number, count: number): number {
  if (count <= 0) return 0;
  return total / count;
}

function rate(part: number, total: number): number | null {
  if (total <= 0) return null;
  return part / total;
}

function sourceBreakdownFromRow(row: Record<string, unknown> | undefined): SkillUsageSourceBreakdown {
  return {
    strongActive: numberValue(row?.strongActiveUseCount),
    semiActive: numberValue(row?.semiActiveUseCount),
    passive: numberValue(row?.passiveUseCount),
  };
}

function agentBreakdownFromRow(row: Record<string, unknown> | undefined): SkillUsageAgentBreakdown {
  return {
    claude: numberValue(row?.claudeUseCount),
    codex: numberValue(row?.codexUseCount),
  };
}

function readObservationFromRows(rows: Array<Record<string, unknown>>): SkillUsageReadObservation {
  const bySession = new Map<string, number[]>();
  for (const row of rows) {
    const sessionKey = stringValue(row.sessionKey);
    if (!sessionKey) continue;
    const seenAt = numberValue(row.seenAt);
    const items = bySession.get(sessionKey) ?? [];
    items.push(seenAt);
    bySession.set(sessionKey, items);
  }
  const fileReadCount = rows.length;
  const sessionsWithFileRead = bySession.size;
  const shortWindowRereadSessionCount = [...bySession.values()]
    .filter((timestamps) => hasShortWindowReread(timestamps))
    .length;
  return {
    fileReadCount,
    sessionsWithFileRead,
    averageFileReadsPerSession: average(fileReadCount, sessionsWithFileRead),
    extraFileReadCount: Math.max(0, fileReadCount - sessionsWithFileRead),
    shortWindowRereadSessionCount,
    shortWindowRereadRate: rate(shortWindowRereadSessionCount, sessionsWithFileRead),
  };
}

function buildReadObservations(
  rows: Array<Record<string, unknown>>,
): { overall: SkillUsageReadObservation; byVersion: Map<string, SkillUsageReadObservation> } {
  const grouped = new Map<string, Array<Record<string, unknown>>>();
  for (const row of rows) {
    const hash = stringValue(row.skillDocumentHash);
    if (!hash) continue;
    const items = grouped.get(hash) ?? [];
    items.push(row);
    grouped.set(hash, items);
  }
  return {
    overall: readObservationFromRows(rows),
    byVersion: new Map([...grouped].map(([hash, items]) => [hash, readObservationFromRows(items)])),
  };
}

function createEmptyReadObservation(): SkillUsageReadObservation {
  return {
    fileReadCount: 0,
    sessionsWithFileRead: 0,
    averageFileReadsPerSession: 0,
    extraFileReadCount: 0,
    shortWindowRereadSessionCount: 0,
    shortWindowRereadRate: null,
  };
}

function hasShortWindowReread(timestamps: number[]): boolean {
  if (timestamps.length < SHORT_WINDOW_REREAD_THRESHOLD) return false;
  const sorted = [...timestamps].sort(byNumberAsc);
  for (let index = 0; index <= sorted.length - SHORT_WINDOW_REREAD_THRESHOLD; index += 1) {
    const first = sorted[index];
    const last = sorted[index + SHORT_WINDOW_REREAD_THRESHOLD - 1];
    if (last - first <= SHORT_WINDOW_REREAD_WINDOW_MS) return true;
  }
  return false;
}

function estimateDocumentSize(content: string): SkillUsageDocumentSize {
  return {
    characterCount: content.length,
    byteCount: Buffer.byteLength(content, 'utf-8'),
    estimatedTokenCount: content.length === 0 ? 0 : Math.ceil(content.length / 4),
  };
}

function skillUsageFilter(
  skillName: string,
  analyzerVersion: string | null,
  recentSince: number,
): { sql: string; params: unknown[] } {
  const clauses = ['skill_name = ?'];
  const params: unknown[] = [skillName];
  if (analyzerVersion !== null) {
    clauses.push('analyzer_version = ?');
    params.push(analyzerVersion);
  }
  clauses.push('seen_at >= ?');
  params.push(recentSince);
  return { sql: clauses.join('\n      AND '), params };
}

function skillUsageEvidenceFilter(
  skillName: string,
  skillDocumentHash: string | null,
  analyzerVersion: string | null,
  recentSince: number,
): { sql: string; params: unknown[] } {
  const filter = skillUsageFilter(skillName, analyzerVersion, recentSince);
  if (skillDocumentHash === null) return filter;
  return {
    sql: `${filter.sql}\n      AND skill_document_hash = ?`,
    params: [...filter.params, skillDocumentHash],
  };
}

function toRecentSourceRecords(rows: Array<Record<string, unknown>>): SkillUsageRecentSourceRecord[] {
  return rows.map((row) => {
    const agentKind: SkillUsageAgentKind = stringValue(row.agentKind) === 'claude-code' ? 'claude-code' : stringValue(row.agentKind) === 'pi' ? 'pi' : 'codex';
    return {
      rawFilePath: stringValue(row.rawFilePath),
      agentKind,
      sessionId: stringValue(row.sessionId),
      sdkSessionId: stringValue(row.sdkSessionId),
    };
  }).filter((row) => row.rawFilePath && row.sessionId && row.sdkSessionId);
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
