/**
 * Workflow 进度读取器(逐 agent 树的数据源)
 * ---------------------------------------------------------------------------
 * Claude Code SDK 的 dynamic workflow 把内部子 agent 的明细写进磁盘的运行记录
 * `~/.claude/projects/<slug>/<sdkSessionId>/workflows/wf_*.json`,**不进事件流**
 * (workflow 在父会话只呈现为单个 local_workflow 任务)。要在 UI 里展示逐 agent 的
 * 进度树,只能读这个记录文件。
 *
 * ⚠️ 稳定性提示:记录文件的目录布局、project-slug 规则、`wf_*.json` schema 都是
 * Claude Code 的**内部实现、无公开契约**,`claude` 二进制升级后可能变动。因此本模块
 * **全程防御式**:任一步失败(目录不存在 / 文件损坏 / schema 变化 / 找不到匹配)都返回
 * null,让上层优雅回退到 workflow 级卡片,绝不抛异常污染主流程。
 *
 * 关联锚点:事件流里 local_workflow 任务的 `task_id` === 记录文件顶层的 `taskId`
 * (实测 2026-07-01 验证)。据此在 workflows 目录里扫描匹配。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

import type {
  WorkflowAgentProgress,
  WorkflowPhaseProgress,
  WorkflowProgress,
} from '../../shared/workflow-progress.js';

export type {
  WorkflowAgentProgress,
  WorkflowPhaseProgress,
  WorkflowProgress,
} from '../../shared/workflow-progress.js';

/**
 * 复现 Claude Code 的 project-slug 规则:工作目录里每个非字母数字字符 → '-'
 * (含前导 '/')。实测:
 *   /Users/alice/Library/Application Support/xdt-maker/dialogues/2026-07-01/<id>
 *   → -Users-alice-Library-Application-Support-xdt-maker-dialogues-2026-07-01-<id>
 * 返回该 session 的 workflows 目录绝对路径。
 */
export function deriveWorkflowsDir(
  homeDir: string,
  workingDir: string,
  sdkSessionId: string,
): string {
  return homePathModule(homeDir).join(
    deriveProjectDir(homeDir, workingDir),
    sdkSessionId,
    'workflows',
  );
}

/** 该工作目录的 project 根(各 sdkSessionId 子目录的父级)。 */
function deriveProjectDir(homeDir: string, workingDir: string): string {
  const slug = workingDir.replace(/[^a-zA-Z0-9]/g, '-');
  return homePathModule(homeDir).join(homeDir, '.claude', 'projects', slug);
}

function homePathModule(homeDir: string): typeof path.posix {
  return /^[A-Za-z]:[\\/]/.test(homeDir) || homeDir.startsWith('\\\\') ? path.win32 : path.posix;
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * 防御截断:非空字符串超过 max 时截到 max-1 并追加省略号(总长仍 ≤ max)。
 * 记录文件里的预览/摘要字段无长度契约,进 IPC 前必须收窄。
 */
function asTruncated(v: unknown, max: number): string | undefined {
  const s = asString(v);
  if (s === undefined) return undefined;
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * 把一份 wf_*.json 记录解析成 WorkflowProgress。schema 不符时尽量宽容:
 * 缺字段就省略,坏条目就跳过;顶层缺 runId 视为不可用返回 null。
 */
export function extractWorkflowProgress(record: unknown): WorkflowProgress | null {
  if (!record || typeof record !== 'object') return null;
  const r = record as Record<string, unknown>;
  const runId = asString(r.runId);
  if (!runId) return null;

  const phases: WorkflowPhaseProgress[] = [];
  const agents: WorkflowAgentProgress[] = [];
  const progress = Array.isArray(r.workflowProgress) ? r.workflowProgress : [];
  for (const rawEntry of progress) {
    if (!rawEntry || typeof rawEntry !== 'object') continue;
    const e = rawEntry as Record<string, unknown>;
    if (e.type === 'workflow_phase') {
      const title = asString(e.title);
      const index = asNumber(e.index);
      if (title && index != null) phases.push({ index, title });
    } else if (e.type === 'workflow_agent') {
      // agentId 允许缺失:排队中的 agent 尚未分配 id(事件流侧同语义),workflow
      // 提前退出时文件里会留下这种行 —— 丢弃会让重载后的树比 live 少行。
      // label 与 agentId 双缺才跳过(没有任何可展示身份)。
      const agentId = asString(e.agentId);
      const state = asString(e.state);
      const label = asString(e.label) ?? agentId;
      if (!label || !state) continue;
      const model = asString(e.model);
      const phaseTitle = asString(e.phaseTitle);
      const phaseIndex = asNumber(e.phaseIndex);
      const attempt = asNumber(e.attempt);
      const lastToolName = asTruncated(e.lastToolName, 200);
      const lastToolSummary = asTruncated(e.lastToolSummary, 160);
      const resultPreview = asTruncated(e.resultPreview, 300);
      const durationMs = asNumber(e.durationMs);
      const error = asTruncated(e.error, 300);
      agents.push({
        label,
        ...(agentId ? { agentId } : {}),
        state,
        ...(model ? { model } : {}),
        ...(phaseTitle ? { phaseTitle } : {}),
        ...(phaseIndex != null ? { phaseIndex } : {}),
        ...(attempt != null ? { attempt } : {}),
        ...(lastToolName ? { lastToolName } : {}),
        ...(lastToolSummary ? { lastToolSummary } : {}),
        ...(resultPreview ? { resultPreview } : {}),
        ...(durationMs != null ? { durationMs } : {}),
        ...(error ? { error } : {}),
      });
    }
  }

  // phases 兜底:workflowProgress 没有 workflow_phase 条目时,退回顶层 phases[]。
  if (phases.length === 0 && Array.isArray(r.phases)) {
    r.phases.forEach((p, i) => {
      if (p && typeof p === 'object') {
        const title = asString((p as Record<string, unknown>).title);
        if (title) phases.push({ index: i + 1, title });
      }
    });
  }

  // detail 只存在于顶层 phases[](workflowProgress 的 phase 条目不带该字段),
  // 按 title 回填;撞名取首个,查不到就不写。兜底路径的条目同样在此覆盖。
  if (phases.length > 0 && Array.isArray(r.phases)) {
    const detailByTitle = new Map<string, string>();
    for (const raw of r.phases) {
      if (!raw || typeof raw !== 'object') continue;
      const p = raw as Record<string, unknown>;
      const title = asString(p.title);
      const detail = asTruncated(p.detail, 200);
      if (title && detail && !detailByTitle.has(title)) detailByTitle.set(title, detail);
    }
    for (const phase of phases) {
      const detail = detailByTitle.get(phase.title);
      if (detail) phase.detail = detail;
    }
  }

  // logs:脚本 log() 的叙述行。只收字符串项,保留最后 50 条、每条 ≤300。
  const logs = Array.isArray(r.logs)
    ? r.logs
        .filter((l): l is string => typeof l === 'string' && l.length > 0)
        .slice(-50)
        .map((l) => asTruncated(l, 300)!)
    : [];

  return {
    runId,
    ...(asString(r.workflowName) ? { workflowName: asString(r.workflowName) } : {}),
    status: asString(r.status) ?? 'running',
    ...(asNumber(r.agentCount) != null ? { agentCount: asNumber(r.agentCount) } : {}),
    ...(asNumber(r.totalTokens) != null ? { totalTokens: asNumber(r.totalTokens) } : {}),
    ...(asNumber(r.totalToolCalls) != null ? { totalToolCalls: asNumber(r.totalToolCalls) } : {}),
    ...(asNumber(r.durationMs) != null ? { durationMs: asNumber(r.durationMs) } : {}),
    ...(logs.length > 0 ? { logs } : {}),
    phases,
    agents,
  };
}

/**
 * 在 session 的 workflows 目录里找到 taskId 匹配的运行记录并解析。
 * 找不到目录 / 无匹配 / 全部解析失败都返回 null(防御式,永不抛)。
 *
 * 说明:一个 session 内 workflow 通常只有个位数,直接扫描 + 解析可接受;后续量大可
 * 按 taskId 建缓存。
 */
export async function readWorkflowProgressByTaskId(
  workflowsDir: string,
  taskId: string,
): Promise<WorkflowProgress | null> {
  if (!taskId) return null;
  let entries: string[];
  try {
    entries = await fs.readdir(workflowsDir);
  } catch {
    return null; // 目录不存在(该 session 没跑过 workflow)等
  }
  const files = entries.filter((f) => f.startsWith('wf_') && f.endsWith('.json'));
  for (const file of files) {
    try {
      const raw = await fs.readFile(path.join(workflowsDir, file), 'utf8');
      const record = JSON.parse(raw) as Record<string, unknown>;
      if (record?.taskId !== taskId) continue;
      return extractWorkflowProgress(record);
    } catch {
      continue; // 单个文件坏了不影响其它
    }
  }
  return null;
}

/** 跨 session 扫描的目录数上限:防御异常庞大的 project 目录,正常仓库远够用。 */
const CROSS_SESSION_SCAN_MAX_DIRS = 200;

/**
 * 按 taskId 定位 workflow 记录,带跨 sdkSessionId 换代兜底:
 * 1. 先读当前 sdkSessionId 的精确目录(绝大多数命中在这);
 * 2. miss 时扫描同 project 下其它 session 目录 —— CC resume 会换 sdkSessionId,
 *    换代前跑的 workflow 记录留在旧目录,只用最新 id 定位必落空。
 * taskId(wf_ 随机 id)全局唯一,跨目录匹配不会错配;目录数超上限时放弃剩余
 * (best-effort,与其余读取路径同一降级语义)。
 */
export async function readWorkflowProgressForSession(
  homeDir: string,
  workingDir: string,
  // null = 会话没有当前 sdkSessionId(/clear 会把持久化列置空):跳过精确目录,
  // 直接跨目录扫描 —— taskId 全局唯一,定位只需要 workingDir。
  sdkSessionId: string | null,
  taskId: string,
): Promise<WorkflowProgress | null> {
  if (sdkSessionId) {
    const exact = await readWorkflowProgressByTaskId(
      deriveWorkflowsDir(homeDir, workingDir, sdkSessionId),
      taskId,
    );
    if (exact) return exact;
  }
  const projectDir = deriveProjectDir(homeDir, workingDir);
  const homePath = homePathModule(homeDir);
  let projectEntries: import('node:fs').Dirent[];
  try {
    projectEntries = await fs.readdir(projectDir, { withFileTypes: true });
  } catch {
    return null;
  }
  let scanned = 0;
  for (const ent of projectEntries) {
    // project 根同时存放 <sdkSessionId>.jsonl 转录文件:上限只对 session 目录
    // 计数,否则大项目里普通文件先把配额吃光,老 workflow 目录根本轮不到。
    if (!ent.isDirectory()) continue;
    if (ent.name === sdkSessionId) continue; // 精确目录已查过
    if (scanned >= CROSS_SESSION_SCAN_MAX_DIRS) break;
    scanned += 1;
    const progress = await readWorkflowProgressByTaskId(
      homePath.join(projectDir, ent.name, 'workflows'),
      taskId,
    );
    if (progress) return progress;
  }
  return null;
}
