import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  deriveWorkflowsDir,
  extractWorkflowProgress,
  readWorkflowProgressByTaskId,
  readWorkflowProgressForSession,
} from '../reader';

// 取自实测的真实 wf_*.json 结构(裁剪;2026-07 样本含 lastTool*/resultPreview/
// durationMs/logs/phases[].detail 等字段,promptPreview/tokens 等未透传字段保留在
// fixture 里验证会被忽略)。
const REAL_RECORD = {
  runId: 'wf_fe3a6ac8-543',
  taskId: 'wmowi77vg',
  workflowName: 'parallel-news-scan',
  status: 'completed',
  agentCount: 2,
  totalTokens: 12345,
  totalToolCalls: 7,
  durationMs: 9045,
  logs: ['共 2 条结果,验证后全部保留'],
  phases: [{ title: 'Search', detail: '2 个并行搜索维度:AI 技术 / 财经' }],
  workflowProgress: [
    { type: 'workflow_phase', index: 1, title: 'Search' },
    {
      type: 'workflow_agent',
      index: 1,
      label: 'search:ai-tech',
      phaseIndex: 1,
      phaseTitle: 'Search',
      agentId: 'a88d563bf7405b73c',
      model: 'claude-opus-4-8[1m]',
      state: 'done',
      startedAt: 1782941756057,
      queuedAt: 1782941756043,
      attempt: 1,
      lastToolName: 'StructuredOutput',
      lastToolSummary: '核心断言全部实测确认',
      resultPreview: '{"findings":[{"title":"AI 技术要点"}]}',
      promptPreview: '你在搜索 AI 技术新闻…',
      lastProgressAt: 1782941956009,
      tokens: 55742,
      toolCalls: 13,
      durationMs: 1999,
    },
    {
      type: 'workflow_agent',
      index: 2,
      label: 'search:finance',
      phaseIndex: 1,
      phaseTitle: 'Search',
      agentId: 'a4435b452d12607d4',
      model: 'claude-opus-4-8[1m]',
      state: 'running',
      attempt: 1,
    },
  ],
};

describe('deriveWorkflowsDir', () => {
  it('reproduces the Claude Code project-slug convention (verified against a real path)', () => {
    const dir = deriveWorkflowsDir(
      '/home/x',
      '/Users/alice/Library/Application Support/xdt-maker/dialogues/2026-07-01/7c0b5faa-d908-4a69-b4e7-0e942b9af582',
      '5b094418-10ba-4bca-b42a-f37aa0721e77',
    );
    expect(dir).toBe(
      '/home/x/.claude/projects/' +
        '-Users-alice-Library-Application-Support-xdt-maker-dialogues-2026-07-01-7c0b5faa-d908-4a69-b4e7-0e942b9af582/' +
        '5b094418-10ba-4bca-b42a-f37aa0721e77/workflows',
    );
  });
});

describe('extractWorkflowProgress', () => {
  it('parses phases and agents from a real-shaped record', () => {
    const p = extractWorkflowProgress(REAL_RECORD);
    expect(p).not.toBeNull();
    expect(p).toMatchObject({
      runId: 'wf_fe3a6ac8-543',
      workflowName: 'parallel-news-scan',
      status: 'completed',
      agentCount: 2,
      totalTokens: 12345,
      totalToolCalls: 7,
      durationMs: 9045,
    });
    expect(p!.logs).toEqual(['共 2 条结果,验证后全部保留']);
    expect(p!.phases).toEqual([
      { index: 1, title: 'Search', detail: '2 个并行搜索维度:AI 技术 / 财经' },
    ]);
    expect(p!.agents).toEqual([
      {
        label: 'search:ai-tech',
        agentId: 'a88d563bf7405b73c',
        model: 'claude-opus-4-8[1m]',
        state: 'done',
        phaseTitle: 'Search',
        phaseIndex: 1,
        attempt: 1,
        lastToolName: 'StructuredOutput',
        lastToolSummary: '核心断言全部实测确认',
        resultPreview: '{"findings":[{"title":"AI 技术要点"}]}',
        durationMs: 1999,
      },
      {
        label: 'search:finance',
        agentId: 'a4435b452d12607d4',
        model: 'claude-opus-4-8[1m]',
        state: 'running',
        phaseTitle: 'Search',
        phaseIndex: 1,
        attempt: 1,
      },
    ]);
  });

  it('truncates oversized agent detail fields to their caps (ellipsis included in cap)', () => {
    const p = extractWorkflowProgress({
      runId: 'wf_x',
      status: 'running',
      workflowProgress: [
        {
          type: 'workflow_agent',
          agentId: 'a1',
          state: 'failed',
          lastToolName: 'n'.repeat(250),
          lastToolSummary: 's'.repeat(200),
          resultPreview: 'r'.repeat(400),
          error: 'e'.repeat(400),
        },
      ],
    });
    const a = p!.agents[0]!;
    expect(a.lastToolName).toBe('n'.repeat(199) + '…');
    expect(a.lastToolName).toHaveLength(200);
    expect(a.lastToolSummary).toBe('s'.repeat(159) + '…');
    expect(a.lastToolSummary).toHaveLength(160);
    expect(a.resultPreview).toBe('r'.repeat(299) + '…');
    expect(a.resultPreview).toHaveLength(300);
    expect(a.error).toBe('e'.repeat(299) + '…');
    expect(a.error).toHaveLength(300);
  });

  it('backfills phase detail from top-level phases[] by title, first entry wins on duplicates', () => {
    const p = extractWorkflowProgress({
      runId: 'wf_x',
      status: 'running',
      phases: [
        { title: 'A', detail: 'first-A' },
        { title: 'A', detail: 'second-A' },
        { title: 'B', detail: 'd'.repeat(260) },
        { title: 'C' }, // 无 detail → 不回填
      ],
      workflowProgress: [
        { type: 'workflow_phase', index: 1, title: 'A' },
        { type: 'workflow_phase', index: 2, title: 'B' },
        { type: 'workflow_phase', index: 3, title: 'C' },
      ],
    });
    expect(p!.phases[0]).toEqual({ index: 1, title: 'A', detail: 'first-A' });
    expect(p!.phases[1]!.detail).toBe('d'.repeat(199) + '…');
    expect(p!.phases[1]!.detail).toHaveLength(200);
    expect(p!.phases[2]).toEqual({ index: 3, title: 'C' });
  });

  it('keeps only the last 50 logs, truncates each to 300, and skips non-string items', () => {
    const raw = Array.from({ length: 60 }, (_, i) => `log-${i}`);
    const p = extractWorkflowProgress({
      runId: 'wf_x',
      status: 'running',
      logs: [...raw, 42, null, 'x'.repeat(350)],
      workflowProgress: [],
    });
    expect(p!.logs).toHaveLength(50);
    // 非字符串项被剔除后再取末 50 条:log-11..log-59 + 超长行。
    expect(p!.logs![0]).toBe('log-11');
    expect(p!.logs![48]).toBe('log-59');
    expect(p!.logs![49]).toBe('x'.repeat(299) + '…');
    expect(p!.logs![49]).toHaveLength(300);
  });

  it('omits logs and the new optional fields when absent (old behavior unchanged)', () => {
    const p = extractWorkflowProgress({
      runId: 'wf_x',
      status: 'running',
      workflowProgress: [{ type: 'workflow_agent', agentId: 'a1', state: 'done' }],
    });
    expect(p).toEqual({
      runId: 'wf_x',
      status: 'running',
      phases: [],
      agents: [{ label: 'a1', agentId: 'a1', state: 'done' }],
    });
    expect('logs' in p!).toBe(false);
  });

  it('falls back to top-level phases[] when workflowProgress has no phase entries', () => {
    const p = extractWorkflowProgress({
      runId: 'wf_x',
      status: 'running',
      phases: [{ title: 'A' }, { title: 'B' }],
      workflowProgress: [],
    });
    expect(p!.phases).toEqual([
      { index: 1, title: 'A' },
      { index: 2, title: 'B' },
    ]);
    expect(p!.agents).toEqual([]);
  });

  it('skips malformed agent entries but keeps valid ones', () => {
    const p = extractWorkflowProgress({
      runId: 'wf_x',
      status: 'running',
      workflowProgress: [
        { type: 'workflow_agent', label: 'no-state' }, // 缺 state → skip
        { type: 'workflow_agent', state: 'queued' }, // label 与 agentId 双缺 → skip
        { type: 'workflow_agent', agentId: 'a1', state: 'done' }, // label 缺 → 回退 agentId
      ],
    });
    expect(p!.agents).toEqual([{ label: 'a1', agentId: 'a1', state: 'done' }]);
  });

  it('keeps agents that have a label but no assigned agentId yet (queued rows)', () => {
    // 排队中的 agent 尚未分配 id(事件流侧同形态):不得丢行,否则重载后的树
    // 比 live 少行。
    const p = extractWorkflowProgress({
      runId: 'wf_x',
      status: 'running',
      workflowProgress: [
        { type: 'workflow_agent', label: 'verify:auth', state: 'queued', phaseIndex: 0 },
      ],
    });
    expect(p!.agents).toEqual([{ label: 'verify:auth', state: 'queued', phaseIndex: 0 }]);
  });

  it('returns null when runId is missing or input is not an object', () => {
    expect(extractWorkflowProgress({ status: 'completed' })).toBeNull();
    expect(extractWorkflowProgress(null)).toBeNull();
    expect(extractWorkflowProgress('nope')).toBeNull();
  });
});

describe('readWorkflowProgressByTaskId', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-reader-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('finds the record whose taskId matches and parses it', async () => {
    await fs.writeFile(path.join(dir, 'wf_other-111.json'), JSON.stringify({ runId: 'wf_o', taskId: 'other', workflowProgress: [] }));
    await fs.writeFile(path.join(dir, 'wf_fe3a6ac8-543.json'), JSON.stringify(REAL_RECORD));
    const p = await readWorkflowProgressByTaskId(dir, 'wmowi77vg');
    expect(p?.runId).toBe('wf_fe3a6ac8-543');
    expect(p?.agents).toHaveLength(2);
  });

  it('returns null when no file matches the taskId', async () => {
    await fs.writeFile(path.join(dir, 'wf_a.json'), JSON.stringify({ runId: 'wf_a', taskId: 'nope', workflowProgress: [] }));
    expect(await readWorkflowProgressByTaskId(dir, 'missing')).toBeNull();
  });

  it('returns null (does not throw) when the workflows dir does not exist', async () => {
    expect(await readWorkflowProgressByTaskId(path.join(dir, 'nope'), 'x')).toBeNull();
  });

  it('skips a malformed json file and still finds a valid matching one', async () => {
    await fs.writeFile(path.join(dir, 'wf_broken.json'), '{ not valid json');
    await fs.writeFile(path.join(dir, 'wf_ok.json'), JSON.stringify({ ...REAL_RECORD, runId: 'wf_ok' }));
    const p = await readWorkflowProgressByTaskId(dir, 'wmowi77vg');
    expect(p?.runId).toBe('wf_ok');
  });

  it('returns null for empty taskId', async () => {
    expect(await readWorkflowProgressByTaskId(dir, '')).toBeNull();
  });
});

describe('readWorkflowProgressForSession(跨 sdkSessionId 换代兜底)', () => {
  let home: string;
  // slug 规则:非字母数字 → '-'(含前导 '/')。
  const workingDir = '/tmp/proj x';
  const slug = '-tmp-proj-x';

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-home-'));
  });
  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  async function writeRecord(sdkSessionId: string, record: Record<string, unknown>) {
    const dir = path.join(home, '.claude', 'projects', slug, sdkSessionId, 'workflows');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${String(record.runId)}.json`), JSON.stringify(record));
  }

  it('当前 sdkSessionId 目录命中时直接返回', async () => {
    await writeRecord('sdk-new', { runId: 'wf_new', taskId: 't1', workflowProgress: [] });
    const p = await readWorkflowProgressForSession(home, workingDir, 'sdk-new', 't1');
    expect(p?.runId).toBe('wf_new');
  });

  it('resume 换代后:精确目录 miss,按 taskId 在旧 session 目录里找到记录', async () => {
    await writeRecord('sdk-old', { runId: 'wf_old', taskId: 't1', workflowProgress: [] });
    await writeRecord('sdk-new', { runId: 'wf_x', taskId: 'other', workflowProgress: [] });
    const p = await readWorkflowProgressForSession(home, workingDir, 'sdk-new', 't1');
    expect(p?.runId).toBe('wf_old');
  });

  it('全部目录无匹配 → null;project 目录不存在 → null(不抛)', async () => {
    await writeRecord('sdk-old', { runId: 'wf_old', taskId: 'other', workflowProgress: [] });
    expect(await readWorkflowProgressForSession(home, workingDir, 'sdk-new', 'missing')).toBeNull();
    expect(await readWorkflowProgressForSession(home, '/no/such/proj', 'sdk-x', 't1')).toBeNull();
  });

  it('sdkSessionId 为 null(/clear 置空)时跳过精确目录,跨目录扫描仍能命中', async () => {
    await writeRecord('sdk-old', { runId: 'wf_old', taskId: 't1', workflowProgress: [] });
    const p = await readWorkflowProgressForSession(home, workingDir, null, 't1');
    expect(p?.runId).toBe('wf_old');
  });

  it('project 根的 <sdkSessionId>.jsonl 转录文件不消耗扫描配额', async () => {
    // 长寿项目根目录里普通文件远多于 session 目录:配额只对目录计数,
    // 否则 readdir 顺序里文件排前时老 workflow 目录根本轮不到。
    const projectDir = path.join(home, '.claude', 'projects', slug);
    await fs.mkdir(projectDir, { recursive: true });
    await Promise.all(
      Array.from({ length: 210 }, (_, i) =>
        fs.writeFile(path.join(projectDir, `aaa-transcript-${String(i).padStart(3, '0')}.jsonl`), ''),
      ),
    );
    await writeRecord('zzz-sdk-old', { runId: 'wf_old', taskId: 't1', workflowProgress: [] });
    const p = await readWorkflowProgressForSession(home, workingDir, 'sdk-new', 't1');
    expect(p?.runId).toBe('wf_old');
  });
});
