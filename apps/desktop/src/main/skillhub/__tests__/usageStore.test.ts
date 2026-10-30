import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import type { DbClient } from '../../localDb/client/DbClient';
import * as usageStore from '../usageStore';
import {
  deleteSkillUsageRecordsBefore,
  getSkillUsageDiagnosisContextFromDb,
  getSkillUsageSummaryFromDb,
  markSkillUsageSourceFailed,
  persistSkillUsageAnalysis,
} from '../usageStore';

function createDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE skill_usage_sources (
      raw_file_path TEXT PRIMARY KEY,
      analyzer_version TEXT NOT NULL DEFAULT '5',
      agent_kind TEXT NOT NULL,
      session_id TEXT NOT NULL,
      sdk_session_id TEXT NOT NULL,
      mtime_ms INTEGER NOT NULL DEFAULT 0,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      last_scanned_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'ok',
      error TEXT
    );
    CREATE TABLE skill_usage_exposures (
      id TEXT PRIMARY KEY,
      analyzer_version TEXT NOT NULL DEFAULT '5',
      raw_file_path TEXT NOT NULL,
      raw_line_no INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      sdk_session_id TEXT NOT NULL,
      agent_kind TEXT NOT NULL,
      skill_name TEXT NOT NULL,
      skill_path TEXT,
      skill_document_hash TEXT,
      exposure_content_hash TEXT NOT NULL,
      document_hash_source TEXT NOT NULL,
      source TEXT NOT NULL,
      tool_use_id TEXT,
      seen_at INTEGER NOT NULL,
      tool_call_count INTEGER NOT NULL DEFAULT 0,
      repeated_tool_call_count INTEGER NOT NULL DEFAULT 0,
      tool_error_count INTEGER NOT NULL DEFAULT 0,
      command_call_count INTEGER NOT NULL DEFAULT 0,
      command_failure_count INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (raw_file_path) REFERENCES skill_usage_sources(raw_file_path) ON DELETE CASCADE
    );
    CREATE INDEX idx_skill_usage_exposures_skill_recent
      ON skill_usage_exposures (skill_name, analyzer_version, seen_at);
    CREATE INDEX idx_skill_usage_exposures_skill_recent_any_version
      ON skill_usage_exposures (skill_name, seen_at);
    CREATE INDEX idx_skill_usage_exposures_analyzer_recent_source
      ON skill_usage_exposures (analyzer_version, seen_at, raw_file_path);
  `);
  return db;
}

function createQueryClient(db: Database.Database): DbClient {
  return {
    query: async <T>(sql: string, params: unknown[] = []) => db.prepare(sql).all(...params) as T[],
    queryOne: async <T>(sql: string, params: unknown[] = []) => db.prepare(sql).get(...params) as T | undefined,
  } as DbClient;
}

type DiagnosisContextGetter = (
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
) => {
  prompt: string;
  evidence: Array<{
    bucket: string;
    rawFilePath: string;
    rawLineNo: number;
    skillDocumentHash: string | null;
    exposureContentHash: string;
    documentHashSource: string;
    observation: {
      toolCallCount: number;
      repeatedToolCallCount: number;
      toolErrorCount: number;
      commandCallCount: number;
      commandFailureCount: number;
    };
  }>;
};

function persistExposure(db: Database.Database, row: {
  id: string;
  rawFilePath: string;
  rawLineNo: number;
  sessionId: string;
  sdkSessionId: string;
  skillDocumentHash: string | null;
  exposureContentHash?: string;
  documentHashSource?: string;
  agentKind?: 'claude-code' | 'codex';
  skillName?: string;
  skillPath?: string | null;
  source?: string;
  toolUseId?: string | null;
  seenAt: number;
  toolCallCount?: number;
  repeatedToolCallCount?: number;
  toolErrorCount?: number;
  commandCallCount?: number;
  commandFailureCount?: number;
  analyzerVersion?: string;
}): void {
  const analyzerVersion = row.analyzerVersion ?? '5';
  const rawFilePath = row.rawFilePath;
  db.prepare(`
    INSERT INTO skill_usage_sources (
      raw_file_path, analyzer_version, agent_kind, session_id, sdk_session_id,
      mtime_ms, size_bytes, last_scanned_at, status, error
    )
    VALUES (?, ?, ?, ?, ?, 0, 0, ?, 'ok', NULL)
    ON CONFLICT(raw_file_path) DO NOTHING
  `).run(
    rawFilePath,
    analyzerVersion,
    row.agentKind ?? 'codex',
    row.sessionId,
    row.sdkSessionId,
    row.seenAt,
  );
  db.prepare(`
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
  `).run({
    agentKind: 'codex',
    skillName: 'word-doc',
    skillPath: null,
    exposureContentHash: row.skillDocumentHash ?? `exposure-${row.id}`,
    documentHashSource: row.skillDocumentHash ? 'transcript_file_read' : 'unavailable',
    source: 'codex_skill_file_read',
    toolUseId: null,
    analyzerVersion,
    toolCallCount: 0,
    repeatedToolCallCount: 0,
    toolErrorCount: 0,
    commandCallCount: 0,
    commandFailureCount: 0,
    ...row,
    rawFilePath,
  });
}

function localDayKey(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

const fixtureNowMs = 10_000;
const dayMs = 24 * 60 * 60 * 1000;

describe('skill usage store', () => {
  it.each([
    { analyzerVersion: '6', suffix: 'AND analyzer_version = ?' },
    { analyzerVersion: null, suffix: '' },
  ])('uses the recent-skill index when analyzerVersion is $analyzerVersion', ({ analyzerVersion, suffix }) => {
    const db = createDb();
    try {
      const plan = db.prepare(`
        EXPLAIN QUERY PLAN
        SELECT COUNT(*)
        FROM skill_usage_exposures
        WHERE skill_name = ?
          ${suffix}
          AND seen_at >= ?
      `).all(...(analyzerVersion === null
        ? ['word-doc', 0]
        : ['word-doc', analyzerVersion, 0])) as Array<{ detail: string }>;

      expect(plan.map((row) => row.detail).join('\n')).toContain(
        analyzerVersion === null
          ? 'idx_skill_usage_exposures_skill_recent_any_version'
          : 'idx_skill_usage_exposures_skill_recent',
      );
      expect(plan.some((row) => /^SCAN skill_usage_exposures\b/.test(row.detail))).toBe(false);
    } finally {
      db.close();
    }
  });

  it('uses the analyzer and recent-time prefix for transcript source discovery', () => {
    const db = createDb();
    try {
      const plan = db.prepare(`
        EXPLAIN QUERY PLAN
        SELECT raw_file_path
        FROM skill_usage_exposures
        WHERE analyzer_version = ?
          AND seen_at >= ?
        GROUP BY raw_file_path
        ORDER BY MAX(seen_at) DESC
      `).all('6', 0) as Array<{ detail: string }>;

      expect(plan.map((row) => row.detail).join('\n')).toContain(
        'idx_skill_usage_exposures_analyzer_recent_source',
      );
      expect(plan.some((row) => /^SCAN skill_usage_exposures\b/.test(row.detail))).toBe(false);
    } finally {
      db.close();
    }
  });

  it('returns the same summary through the asynchronous DbClient path', async () => {
    const db = createDb();
    try {
      persistExposure(db, {
        id: 'async-summary',
        rawFilePath: 'async-summary.jsonl',
        rawLineNo: 1,
        sessionId: 'codex-async-summary',
        sdkSessionId: 'async-summary',
        skillDocumentHash: 'doc-current',
        seenAt: fixtureNowMs,
        analyzerVersion: '6',
        toolCallCount: 3,
      });
      const params = {
        skillName: 'word-doc',
        currentDocumentHash: 'doc-current',
        currentDocumentContent: '# Word doc',
        analyzerVersion: '6',
        nowMs: fixtureNowMs,
      };

      const syncSummary = getSkillUsageSummaryFromDb(db, params);
      const asyncSummary = await usageStore.getSkillUsageSummaryFromClient(createQueryClient(db), params);

      expect(asyncSummary).toEqual(syncSummary);
    } finally {
      db.close();
    }
  });

  it('reads diagnosis summary and evidence from one asynchronous snapshot query', async () => {
    const db = createDb();
    try {
      persistExposure(db, {
        id: 'async-diagnosis-read',
        rawFilePath: 'async-diagnosis-read.jsonl',
        rawLineNo: 1,
        sessionId: 'codex-async-diagnosis-read',
        sdkSessionId: 'async-diagnosis-read',
        skillDocumentHash: 'doc-current',
        seenAt: fixtureNowMs,
        analyzerVersion: '6',
      });
      persistExposure(db, {
        id: 'async-diagnosis-failure',
        rawFilePath: 'async-diagnosis-failure.jsonl',
        rawLineNo: 2,
        sessionId: 'codex-async-diagnosis-failure',
        sdkSessionId: 'async-diagnosis-failure',
        skillDocumentHash: 'doc-current',
        seenAt: fixtureNowMs - 1,
        analyzerVersion: '6',
        source: 'codex_skill_tool',
        toolErrorCount: 2,
      });
      const params = {
        skillName: 'word-doc',
        currentDocumentHash: 'doc-current',
        currentDocumentContent: '# Word doc',
        analyzerVersion: '6',
        skillPath: '/skills/word-doc/SKILL.md',
        nowMs: fixtureNowMs,
      };
      const client = createQueryClient(db);
      const querySpy = vi.spyOn(client, 'query');

      const syncContext = getSkillUsageDiagnosisContextFromDb(db, params);
      const asyncContext = await usageStore.getSkillUsageDiagnosisContextFromClient(client, params);

      expect(asyncContext).toEqual(syncContext);
      expect(querySpy).toHaveBeenCalledTimes(1);
      expect(String(querySpy.mock.calls[0]?.[0])).toContain('MATERIALIZED');
    } finally {
      db.close();
    }
  });

  it('persists document and exposure hashes without token metrics', () => {
    const db = createDb();
    try {
      persistSkillUsageAnalysis(db, {
        rawFilePath: 'rollout-a.jsonl',
        analyzerVersion: '5',
        agentKind: 'codex',
        sessionId: 'codex-rollout-a',
        sdkSessionId: 'rollout-a',
        mtimeMs: 1,
        sizeBytes: 100,
        scannedAt: 1_000,
      }, {
        exposures: [
          {
            id: 'exposure-a',
            agentKind: 'codex',
            sessionId: 'codex-rollout-a',
            sdkSessionId: 'rollout-a',
            rawFilePath: 'rollout-a.jsonl',
            rawLineNo: 5,
            skillName: 'word-doc',
            skillPath: '/agent-skill-roots/codex/word-doc',
            skillDocumentHash: 'doc-current',
            exposureContentHash: 'exposure-dynamic-a',
            documentHashSource: 'transcript_skill_content',
            source: 'codex_skill_injection',
            toolUseId: null,
            seenAt: 1_000,
            observation: {
              toolCallCount: 2,
              repeatedToolCallCount: 1,
              toolErrorCount: 0,
              commandCallCount: 1,
              commandFailureCount: 0,
            },
          },
        ],
      });

      const row = db.prepare(`
        SELECT
          skill_document_hash AS skillDocumentHash,
          exposure_content_hash AS exposureContentHash,
          document_hash_source AS documentHashSource,
          tool_call_count AS toolCallCount,
          repeated_tool_call_count AS repeatedToolCallCount
        FROM skill_usage_exposures
      `).get();
      expect(row).toEqual({
        skillDocumentHash: 'doc-current',
        exposureContentHash: 'exposure-dynamic-a',
        documentHashSource: 'transcript_skill_content',
        toolCallCount: 2,
        repeatedToolCallCount: 1,
      });
    } finally {
      db.close();
    }
  });

  it('removes analyzer exposures before the recent observation window', () => {
    const db = createDb();
    try {
      persistExposure(db, {
        id: 'kept',
        analyzerVersion: '6',
        rawFilePath: 'old-mtime-but-recent.jsonl',
        rawLineNo: 1,
        sessionId: 'codex-kept',
        sdkSessionId: 'kept',
        skillDocumentHash: 'doc-current',
        seenAt: 2_000,
      });
      persistExposure(db, {
        id: 'stale',
        analyzerVersion: '6',
        rawFilePath: 'stale.jsonl',
        rawLineNo: 1,
        sessionId: 'codex-stale',
        sdkSessionId: 'stale',
        skillDocumentHash: 'doc-current',
        seenAt: 999,
      });

      deleteSkillUsageRecordsBefore(db, '6', 1_000);

      const summary = getSkillUsageSummaryFromDb(db, {
        skillName: 'word-doc',
        currentDocumentHash: 'doc-current',
        analyzerVersion: '6',
        nowMs: fixtureNowMs,
      });

      expect(summary.totalUseCount).toBe(1);
      expect(summary.latestSeenAt).toBe(2_000);
      expect(db.prepare('SELECT COUNT(*) FROM skill_usage_sources WHERE raw_file_path = ?').pluck().get(
        'old-mtime-but-recent.jsonl',
      )).toBe(1);
    } finally {
      db.close();
    }
  });

  it('keeps source rows while any analyzer version still references them', () => {
    const db = createDb();
    try {
      persistExposure(db, {
        id: 'active-old-version',
        analyzerVersion: '5',
        rawFilePath: 'shared-source.jsonl',
        rawLineNo: 1,
        sessionId: 'codex-old-active',
        sdkSessionId: 'old-active',
        skillDocumentHash: 'doc-current',
        seenAt: 2_000,
      });
      db.prepare(`
        UPDATE skill_usage_sources
        SET analyzer_version = '6', mtime_ms = 1
        WHERE raw_file_path = 'shared-source.jsonl'
      `).run();

      deleteSkillUsageRecordsBefore(db, '6', 1_000);

      expect(db.prepare('SELECT COUNT(*) FROM skill_usage_sources').pluck().get()).toBe(1);
      expect(db.prepare(`
        SELECT COUNT(*) FROM skill_usage_exposures
        WHERE analyzer_version = '5' AND raw_file_path = 'shared-source.jsonl'
      `).pluck().get()).toBe(1);
    } finally {
      db.close();
    }
  });

  it('preserves cached exposures when a retained transcript source fails to refresh', () => {
    const db = createDb();
    try {
      persistExposure(db, {
        id: 'stale',
        analyzerVersion: '6',
        rawFilePath: 'retained-but-failed.jsonl',
        rawLineNo: 1,
        sessionId: 'codex-retained-but-failed',
        sdkSessionId: 'retained-but-failed',
        skillDocumentHash: 'doc-current',
        seenAt: 1_000,
      });

      markSkillUsageSourceFailed(db, {
        rawFilePath: 'retained-but-failed.jsonl',
        analyzerVersion: '6',
        agentKind: 'codex',
        sessionId: 'codex-retained-but-failed',
        sdkSessionId: 'retained-but-failed',
        mtimeMs: 1_500,
        sizeBytes: 1,
        scannedAt: 2_000,
        error: 'read failed',
      });

      const summary = getSkillUsageSummaryFromDb(db, {
        skillName: 'word-doc',
        currentDocumentHash: 'doc-current',
        analyzerVersion: '6',
        nowMs: fixtureNowMs,
      });
      const source = db.prepare('SELECT status, error FROM skill_usage_sources WHERE raw_file_path = ?').get(
        'retained-but-failed.jsonl',
      ) as { status: string; error: string } | undefined;

      expect(summary.totalUseCount).toBe(1);
      expect(source).toEqual({ status: 'failed', error: 'read failed' });
    } finally {
      db.close();
    }
  });

  it('summarizes versions by canonical document hash and counts unversioned exposures separately', () => {
    const db = createDb();
    try {
      persistExposure(db, {
        id: 'current-a',
        rawFilePath: 'rollout-a.jsonl',
        rawLineNo: 10,
        sessionId: 'codex-a',
        sdkSessionId: 'a',
        skillDocumentHash: 'doc-current',
        exposureContentHash: 'exposure-dynamic-a',
        documentHashSource: 'transcript_skill_content',
        seenAt: 1_000,
        toolCallCount: 2,
        commandCallCount: 1,
      });
      persistExposure(db, {
        id: 'current-a-reread',
        rawFilePath: 'rollout-a-reread.jsonl',
        rawLineNo: 12,
        sessionId: 'codex-a',
        sdkSessionId: 'a',
        skillDocumentHash: 'doc-current',
        exposureContentHash: 'exposure-dynamic-a-reread',
        documentHashSource: 'transcript_file_read',
        source: 'codex_skill_file_read',
        seenAt: 1_500,
      });
      persistExposure(db, {
        id: 'current-b',
        rawFilePath: 'rollout-b.jsonl',
        rawLineNo: 20,
        sessionId: 'claude-b',
        sdkSessionId: 'b',
        agentKind: 'claude-code',
        skillDocumentHash: 'doc-current',
        exposureContentHash: 'exposure-dynamic-b',
        documentHashSource: 'transcript_skill_content',
        source: 'claude_skill_tool',
        seenAt: 2_000,
        toolCallCount: 4,
        repeatedToolCallCount: 1,
        commandCallCount: 2,
        commandFailureCount: 1,
      });
      persistExposure(db, {
        id: 'unversioned',
        rawFilePath: 'rollout-c.jsonl',
        rawLineNo: 30,
        sessionId: 'codex-c',
        sdkSessionId: 'c',
        skillDocumentHash: null,
        exposureContentHash: 'exposure-only',
        documentHashSource: 'unavailable',
        source: 'codex_skill_injection',
        seenAt: 3_000,
        toolCallCount: 1,
      });

      const summary = getSkillUsageSummaryFromDb(db, {
        skillName: 'word-doc',
        currentDocumentHash: 'doc-current',
        currentDocumentContent: 'abcd efgh ijkl mnop',
        analyzerVersion: '5',
        nowMs: fixtureNowMs,
      });

      expect(summary.totalUseCount).toBe(4);
      expect(summary.currentDocumentVersionUseCount).toBe(3);
      expect(summary.unversionedUseCount).toBe(1);
      expect(summary.documentVersionCoverageRate).toBe(3 / 4);
      expect(summary.agentBreakdown).toEqual({ claude: 1, codex: 3 });
      expect(summary.sourceBreakdown).toEqual({ strongActive: 1, semiActive: 2, passive: 1 });
      expect(summary.currentDocumentSize).toEqual({
        characterCount: 19,
        byteCount: 19,
        estimatedTokenCount: 5,
      });
      expect(summary.readObservation).toEqual({
        fileReadCount: 2,
        sessionsWithFileRead: 1,
        averageFileReadsPerSession: 2,
        extraFileReadCount: 1,
        shortWindowRereadSessionCount: 0,
        shortWindowRereadRate: 0,
      });
      expect(summary.documentVersions).toHaveLength(1);
      expect(summary.documentVersions[0]).toMatchObject({
        skillDocumentHash: 'doc-current',
        useCount: 3,
        agentBreakdown: { claude: 1, codex: 2 },
        sourceBreakdown: { strongActive: 1, semiActive: 2, passive: 0 },
        readObservation: {
          fileReadCount: 2,
          sessionsWithFileRead: 1,
          averageFileReadsPerSession: 2,
          extraFileReadCount: 1,
          shortWindowRereadSessionCount: 0,
          shortWindowRereadRate: 0,
        },
        toolCallCount: 6,
        repeatedToolCallCount: 1,
        commandCallCount: 3,
        commandFailureCount: 1,
        averageToolCalls: 2,
        averageRepeatedToolCalls: 1 / 3,
        commandFailureRate: 1 / 3,
      });
      expect('averageTokens' in summary.documentVersions[0]).toBe(false);
      expect('agentUseCounts' in summary).toBe(false);
      expect(summary.currentDocumentVersion).toMatchObject({ skillDocumentHash: 'doc-current', useCount: 3 });
    } finally {
      db.close();
    }
  });

  it('summarizes only exposures inside the recent 30-day window', () => {
    const db = createDb();
    const nowMs = Date.UTC(2026, 5, 22, 12);
    try {
      persistExposure(db, {
        id: 'recent',
        rawFilePath: 'rollout-recent.jsonl',
        rawLineNo: 10,
        sessionId: 'codex-recent',
        sdkSessionId: 'recent',
        skillDocumentHash: 'doc-current',
        seenAt: nowMs - 2 * dayMs,
        toolCallCount: 2,
      });
      persistExposure(db, {
        id: 'old',
        rawFilePath: 'rollout-old.jsonl',
        rawLineNo: 20,
        sessionId: 'codex-old',
        sdkSessionId: 'old',
        skillDocumentHash: 'doc-current',
        seenAt: nowMs - 45 * dayMs,
        toolCallCount: 10,
      });

      const summary = getSkillUsageSummaryFromDb(db, {
        skillName: 'word-doc',
        currentDocumentHash: 'doc-current',
        analyzerVersion: '5',
        nowMs,
      });

      expect(summary.totalUseCount).toBe(1);
      expect(summary.currentDocumentVersionUseCount).toBe(1);
      expect(summary.documentVersions[0]?.toolCallCount).toBe(2);
    } finally {
      db.close();
    }
  });

  it('counts rereads only when three file reads happen within thirty minutes', () => {
    const db = createDb();
    try {
      const minute = 60 * 1000;
      for (const [index, seenAt] of [1_000, 1_000 + 10 * minute, 1_000 + 20 * minute].entries()) {
        persistExposure(db, {
          id: `burst-${index}`,
          rawFilePath: `rollout-burst-${index}.jsonl`,
          rawLineNo: 10 + index,
          sessionId: 'codex-burst',
          sdkSessionId: 'burst',
          skillDocumentHash: 'doc-current',
          seenAt,
          source: 'codex_skill_file_read',
        });
      }
      for (const [index, seenAt] of [5_000, 5_000 + 45 * minute].entries()) {
        persistExposure(db, {
          id: `spread-${index}`,
          rawFilePath: `rollout-spread-${index}.jsonl`,
          rawLineNo: 20 + index,
          sessionId: 'codex-spread',
          sdkSessionId: 'spread',
          skillDocumentHash: 'doc-current',
          seenAt,
          source: 'codex_skill_file_read',
        });
      }
      for (const [index, seenAt] of [9_000, 9_000 + 31 * minute, 9_000 + 62 * minute].entries()) {
        persistExposure(db, {
          id: `slow-${index}`,
          rawFilePath: `rollout-slow-${index}.jsonl`,
          rawLineNo: 30 + index,
          sessionId: 'codex-slow',
          sdkSessionId: 'slow',
          skillDocumentHash: 'doc-current',
          seenAt,
          source: 'codex_skill_file_read',
        });
      }

      const summary = getSkillUsageSummaryFromDb(db, {
        skillName: 'word-doc',
        currentDocumentHash: 'doc-current',
        analyzerVersion: '5',
        nowMs: fixtureNowMs,
      });

      expect(summary.readObservation).toEqual({
        fileReadCount: 8,
        sessionsWithFileRead: 3,
        averageFileReadsPerSession: 8 / 3,
        extraFileReadCount: 5,
        shortWindowRereadSessionCount: 1,
        shortWindowRereadRate: 1 / 3,
      });
      expect(summary.currentDocumentVersion?.readObservation).toEqual(summary.readObservation);
    } finally {
      db.close();
    }
  });

  it('keeps analyzer-version scopes independent', () => {
    const db = createDb();
    try {
      persistExposure(db, {
        id: 'v4-row',
        rawFilePath: 'rollout-versioned-v4.jsonl',
        rawLineNo: 10,
        sessionId: 'codex-v4',
        sdkSessionId: 'v4',
        skillDocumentHash: 'doc-v4',
        seenAt: 1_000,
        analyzerVersion: '4',
      });
      persistExposure(db, {
        id: 'v5-row',
        rawFilePath: 'rollout-versioned-v5.jsonl',
        rawLineNo: 10,
        sessionId: 'codex-v5',
        sdkSessionId: 'v5',
        skillDocumentHash: 'doc-v5',
        seenAt: 2_000,
        analyzerVersion: '5',
      });

      const v4Summary = getSkillUsageSummaryFromDb(db, {
        skillName: 'word-doc',
        currentDocumentHash: 'doc-v4',
        analyzerVersion: '4',
        nowMs: fixtureNowMs,
      });
      const v5Summary = getSkillUsageSummaryFromDb(db, {
        skillName: 'word-doc',
        currentDocumentHash: 'doc-v5',
        analyzerVersion: '5',
        nowMs: fixtureNowMs,
      });

      expect(v4Summary.currentDocumentVersionUseCount).toBe(1);
      expect(v4Summary.documentVersions[0].skillDocumentHash).toBe('doc-v4');
      expect(v5Summary.currentDocumentVersionUseCount).toBe(1);
      expect(v5Summary.documentVersions[0].skillDocumentHash).toBe('doc-v5');
    } finally {
      db.close();
    }
  });

  it('builds diagnosis prompts from document-version evidence without average token metrics', () => {
    const db = createDb();
    try {
      const getDiagnosis = (
        usageStore as unknown as { getSkillUsageDiagnosisContextFromDb?: DiagnosisContextGetter }
      ).getSkillUsageDiagnosisContextFromDb;
      expect(getDiagnosis).toBeTypeOf('function');
      if (!getDiagnosis) return;

      const currentDocHash = 'doc-current';
      const oldDocHash = 'doc-old';
      const toolPath = '/tmp/transcripts/tool.jsonl';
      const commandPath = '/tmp/transcripts/command.jsonl';
      const repeatedPath = '/tmp/transcripts/repeated.jsonl';
      const recentPath = '/tmp/transcripts/recent.jsonl';
      persistExposure(db, {
        id: 'tool-failed',
        rawFilePath: toolPath,
        rawLineNo: 14,
        sessionId: 'codex-tool',
        sdkSessionId: 'tool',
        skillDocumentHash: currentDocHash,
        exposureContentHash: 'exposure-tool',
        seenAt: 4_000,
        toolCallCount: 3,
        toolErrorCount: 2,
      });
      persistExposure(db, {
        id: 'old-tool-failed',
        rawFilePath: '/tmp/transcripts/old-tool.jsonl',
        rawLineNo: 77,
        sessionId: 'codex-old-tool',
        sdkSessionId: 'old-tool',
        skillDocumentHash: currentDocHash,
        exposureContentHash: 'exposure-old-tool',
        seenAt: fixtureNowMs - 45 * dayMs,
        toolCallCount: 10,
        toolErrorCount: 9,
      });
      persistExposure(db, {
        id: 'command-failed',
        rawFilePath: commandPath,
        rawLineNo: 22,
        sessionId: 'codex-command',
        sdkSessionId: 'command',
        skillDocumentHash: currentDocHash,
        exposureContentHash: 'exposure-command',
        seenAt: 3_000,
        toolCallCount: 2,
        commandCallCount: 2,
        commandFailureCount: 1,
      });
      persistExposure(db, {
        id: 'repeated-calls',
        rawFilePath: repeatedPath,
        rawLineNo: 35,
        sessionId: 'codex-repeated',
        sdkSessionId: 'repeated',
        skillDocumentHash: currentDocHash,
        exposureContentHash: 'exposure-repeated',
        seenAt: 2_000,
        toolCallCount: 5,
        repeatedToolCallCount: 2,
      });
      persistExposure(db, {
        id: 'recent',
        rawFilePath: recentPath,
        rawLineNo: 48,
        sessionId: 'codex-recent',
        sdkSessionId: 'recent',
        skillDocumentHash: currentDocHash,
        exposureContentHash: 'exposure-recent',
        seenAt: 1_000,
        toolCallCount: 1,
        commandCallCount: 1,
      });
      persistExposure(db, {
        id: 'old-version',
        rawFilePath: '/tmp/transcripts/old.jsonl',
        rawLineNo: 9,
        sessionId: 'codex-old',
        sdkSessionId: 'old',
        skillDocumentHash: oldDocHash,
        exposureContentHash: 'exposure-old',
        seenAt: 5_000,
      });
      persistExposure(db, {
        id: 'unversioned',
        rawFilePath: '/tmp/transcripts/unversioned.jsonl',
        rawLineNo: 11,
        sessionId: 'codex-unversioned',
        sdkSessionId: 'unversioned',
        skillDocumentHash: null,
        exposureContentHash: 'exposure-unversioned',
        documentHashSource: 'unavailable',
        seenAt: 6_000,
      });

      const context = getDiagnosis(db, {
        skillName: 'word-doc',
        currentDocumentHash: currentDocHash,
        currentDocumentContent: 'abcd efgh ijkl mnop',
        skillPath: '/tmp/skills/word-doc/SKILL.md',
        maxEvidence: 4,
        nowMs: fixtureNowMs,
      });

      expect(context.evidence.map((item) => item.bucket)).toEqual([
        'tool_failed',
        'command_failed',
        'repeated_calls',
        'recent',
      ]);
      expect(context.evidence.some((item) => item.skillDocumentHash === oldDocHash)).toBe(false);
      expect(context.evidence.some((item) => item.documentHashSource === 'unavailable')).toBe(false);
      expect(context.evidence[0]).toHaveProperty('observation');
      expect(context.evidence[0]).not.toHaveProperty('outcome');
      expect(context).not.toHaveProperty('evidenceExcerpts');
      expect(context.prompt).toContain('不要修改任何文件；先读取证据并给出诊断');
      expect(context.prompt).toContain('读取目标 skillPath 指向的 SKILL.md');
      expect(context.prompt).toContain('读取每条 rawFilePath 中 rawLineNo 附近上下文');
      expect(context.prompt).toContain('读取失败时说明证据文件不可读');
      expect(context.prompt).toContain('source/file_read 只表示模型接触过文档，不证明后续行为由 skill 导致');
      expect(context.prompt).toContain('不建议改 skill 也是有效结论');
      expect(context.prompt).toContain('排除原因');
      expect(context.prompt).toContain('环境 / 权限 / 依赖问题');
      expect(context.prompt).toContain('样本太少');
      expect(context.prompt).not.toContain('证据摘录');
      expect(context.prompt).toContain('过程摩擦信号');
      expect(context.prompt).toContain('readObservation');
      expect(context.prompt).toContain('currentDocumentSize');
      expect(context.prompt).toContain('processMetrics');
      expect(context.prompt).toContain('versionComparison');
      expect(context.prompt).toContain('"status": "insufficient_sample"');
      expect(context.prompt).not.toContain('"averageToolCalls": 2.75');
      expect(context.prompt).not.toContain('historicalDocumentVersions');
      expect(context.prompt).not.toContain('sourceBreakdown');
      expect(context.prompt).not.toContain('documentVersionCoverageRate');
      expect(context.prompt).not.toContain('unversionedUseCount');
      expect(context.prompt).not.toContain('执行失败');
      expect(context.prompt).not.toContain('executionFailureRate');
      expect(context.prompt).not.toContain('agentUseCounts');
      expect(context.prompt).not.toContain('outcome');
      expect(context.prompt).not.toContain('averageTokens');
      expect(context.prompt).toContain(toolPath);
      expect(context.prompt).not.toContain('/tmp/transcripts/old-tool.jsonl');
      expect(context.prompt).toContain('"rawLineNo": 14');
      expect(context.prompt).not.toContain('RAW_CHAT_TEXT_SHOULD_NOT_APPEAR');
    } finally {
      db.close();
    }
  });

  it('uses the adjacent previous version for diagnosis comparison instead of skipping to older samples', () => {
    const db = createDb();
    try {
      const getDiagnosis = (
        usageStore as unknown as { getSkillUsageDiagnosisContextFromDb?: DiagnosisContextGetter }
      ).getSkillUsageDiagnosisContextFromDb;
      expect(getDiagnosis).toBeTypeOf('function');
      if (!getDiagnosis) return;

      for (let index = 0; index < 5; index += 1) {
        persistExposure(db, {
          id: `current-${index}`,
          rawFilePath: `/tmp/transcripts/current-${index}.jsonl`,
          rawLineNo: 10,
          sessionId: `codex-current-${index}`,
          sdkSessionId: `current-${index}`,
          skillDocumentHash: 'doc-current',
          seenAt: 4_000 + index,
        });
      }
      persistExposure(db, {
        id: 'previous-low-sample',
        rawFilePath: '/tmp/transcripts/previous.jsonl',
        rawLineNo: 10,
        sessionId: 'codex-previous',
        sdkSessionId: 'previous',
        skillDocumentHash: 'doc-previous',
        seenAt: 3_000,
      });
      for (let index = 0; index < 5; index += 1) {
        persistExposure(db, {
          id: `older-${index}`,
          rawFilePath: `/tmp/transcripts/older-${index}.jsonl`,
          rawLineNo: 10,
          sessionId: `codex-older-${index}`,
          sdkSessionId: `older-${index}`,
          skillDocumentHash: 'doc-older',
          seenAt: 2_000 + index,
        });
      }

      const context = getDiagnosis(db, {
        skillName: 'word-doc',
        currentDocumentHash: 'doc-current',
        currentDocumentContent: 'current document',
        nowMs: fixtureNowMs,
      });

      expect(context.prompt).toContain('"status": "previous_low_sample"');
      expect(context.prompt).toContain('"previousUseCount": 1');
      expect(context.prompt).not.toContain('"status": "comparable"');
    } finally {
      db.close();
    }
  });

  it('summarizes the 30-day trend across versioned and unversioned exposures', () => {
    const db = createDb();
    try {
      const today = new Date();
      today.setHours(12, 0, 0, 0);
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);

      persistExposure(db, {
        id: 'current-today',
        rawFilePath: '/tmp/transcripts/current.jsonl',
        rawLineNo: 10,
        sessionId: 'codex-current',
        sdkSessionId: 'current',
        skillDocumentHash: 'doc-current',
        seenAt: today.getTime(),
        toolCallCount: 4,
      });
      persistExposure(db, {
        id: 'old-today',
        rawFilePath: '/tmp/transcripts/old-today.jsonl',
        rawLineNo: 12,
        sessionId: 'codex-old-today',
        sdkSessionId: 'old-today',
        skillDocumentHash: 'doc-old',
        seenAt: today.getTime(),
        toolCallCount: 2,
      });
      persistExposure(db, {
        id: 'unversioned-yesterday',
        rawFilePath: '/tmp/transcripts/unversioned-yesterday.jsonl',
        rawLineNo: 14,
        sessionId: 'codex-unversioned-yesterday',
        sdkSessionId: 'unversioned-yesterday',
        skillDocumentHash: null,
        exposureContentHash: 'exposure-yesterday',
        documentHashSource: 'unavailable',
        seenAt: yesterday.getTime(),
        toolCallCount: 1,
      });

      const summary = getSkillUsageSummaryFromDb(db, {
        skillName: 'word-doc',
        currentDocumentHash: 'doc-current',
        analyzerVersion: '5',
      });

      const trendByDay = new Map(summary.trend.map((point) => [point.day, point]));
      expect(trendByDay.get(localDayKey(yesterday))?.useCount).toBe(1);
      expect(trendByDay.get(localDayKey(today))?.useCount).toBe(2);
      expect(trendByDay.get(localDayKey(today))).not.toHaveProperty('averageTokens');
    } finally {
      db.close();
    }
  });
});
