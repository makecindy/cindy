import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ORCA_COLLABORATION_SETTINGS,
  buildDraftWorkerInitialTask,
  createWorkerLabel,
  orcaWorkerSlotState,
  parseOrcaCollaborationSettings,
  parseOrcaTeamWorkers,
  readOrcaCollabPolicy,
  readOrcaTeamLeadSessionId,
  shouldShowWorkerLabel,
} from '../orcaTeam.js';

describe('orca team shared helpers', () => {
  it('derives unique slug labels from roles', () => {
    expect(createWorkerLabel('Developer', [])).toBe('developer');
    expect(createWorkerLabel('Code Reviewer!', [])).toBe('code-reviewer');
    expect(createWorkerLabel('developer', ['developer', 'Developer-2'])).toBe('developer-3');
    expect(createWorkerLabel('   ', [])).toBe('worker');
    expect(createWorkerLabel('--- lead ---', [])).toBe('lead');
    // 大量连字符也是线性处理(CodeQL:避免可回溯正则)。
    expect(createWorkerLabel(`${'-'.repeat(50_000)}x`, [])).toBe('x');
    expect(shouldShowWorkerLabel('developer', 'developer-2')).toBe(true);
    expect(shouldShowWorkerLabel('developer', 'developer')).toBe(false);
  });

  it('keeps pending Lead input as context only when a Worker task exists', () => {
    expect(buildDraftWorkerInitialTask(undefined, 'lead text')).toBeUndefined();
    expect(buildDraftWorkerInitialTask('  review  ', undefined)).toBe('review');
    expect(buildDraftWorkerInitialTask('review', 'lead text')).toContain('Pending Lead input:\n');
    expect(buildDraftWorkerInitialTask('review', 'lead text')?.endsWith('lead text')).toBe(true);
  });

  it('parses worker records defensively and drops rows without identity', () => {
    const workers = parseOrcaTeamWorkers([
      {
        id: 'w-1',
        sessionId: 's-1',
        role: 'reviewer',
        label: 'reviewer',
        status: 'running',
        focused: true,
        session: { agentKind: 'codex', model: 'gpt-5.5', effort: 'high', title: 'Review' },
      },
      { id: 'w-2', sessionId: 's-2', status: 'weird', session: null },
      { id: 'missing-session' },
      'garbage',
    ]);
    expect(workers).toEqual([
      {
        workerId: 'w-1',
        sessionId: 's-1',
        role: 'reviewer',
        label: 'reviewer',
        status: 'running',
        focused: true,
        agentKind: 'codex',
        model: 'gpt-5.5',
        effort: 'high',
        title: 'Review',
      },
      {
        workerId: 'w-2',
        sessionId: 's-2',
        role: 'developer',
        label: null,
        status: 'idle',
        focused: false,
        agentKind: 'claude-code',
        model: null,
        effort: null,
        title: null,
      },
    ]);
    expect(parseOrcaTeamWorkers(null)).toEqual([]);
  });

  it('parses collaboration settings defensively', () => {
    expect(parseOrcaCollaborationSettings({
      workerSoftLimit: 3,
      workerHardLimit: 6,
      workerIdleReleaseMinutes: 10,
      isCustomized: true,
    })).toEqual({ workerSoftLimit: 3, workerHardLimit: 6, workerIdleReleaseMinutes: 10 });
    expect(parseOrcaCollaborationSettings({ workerSoftLimit: 2 }).workerHardLimit).toBe(8);
    expect(parseOrcaCollaborationSettings('bad')).toEqual(DEFAULT_ORCA_COLLABORATION_SETTINGS);
  });

  it('counts every non-archived Worker against the soft and hard limits', () => {
    const worker = parseOrcaTeamWorkers([{ id: 'w', sessionId: 's' }])[0]!;
    const limits = { workerSoftLimit: 2, workerHardLimit: 3 };
    expect(orcaWorkerSlotState([worker], limits)).toBe('ok');
    expect(orcaWorkerSlotState([worker, worker], limits)).toBe('soft');
    expect(orcaWorkerSlotState([worker, worker, worker], limits)).toBe('hard');
  });

  it('reads the collab policy and fails closed for dialogue on hosts that do not echo the kind', () => {
    expect(readOrcaCollabPolicy({ effectiveEnabled: true }, 'project')).toEqual({ enabled: true, unsupported: false });
    expect(readOrcaCollabPolicy({ effectiveEnabled: false }, 'project')).toEqual({ enabled: false, unsupported: false });
    expect(readOrcaCollabPolicy({ effectiveEnabled: true }, 'dialogue')).toEqual({ enabled: false, unsupported: true });
    expect(readOrcaCollabPolicy({ effectiveEnabled: true, collabWorkspaceKind: 'dialogue' }, 'dialogue'))
      .toEqual({ enabled: true, unsupported: false });
  });

  it('reads the Lead id from a team record', () => {
    expect(readOrcaTeamLeadSessionId({ leadSessionId: 'lead-1' })).toBe('lead-1');
    expect(readOrcaTeamLeadSessionId(null)).toBeNull();
  });
});
