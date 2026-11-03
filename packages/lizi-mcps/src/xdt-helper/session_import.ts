/**
 * xdt-helper/session_import.ts —— 任务导入（control 类，本机）。
 *
 * 与「设置 → 任务导入」同一个实现：扫描这台电脑上其他 AI 编程工具的任务（只读），
 * 按候选 key 在后台导入，查进度与结果。导入只复制，不改动原工具的任何记录。
 *
 * host 注入 sessionImport 回调后注册三个工具：
 *   - scan_importable_sessions：列出可导入的任务（可按来源、项目、关键词筛选，带分页上限）；
 *   - import_sessions：开始导入一批候选 key，立即返回进度标识；
 *   - get_session_import_status：查导入进度与逐项结果（导入后的任务 id、能否直接续做、问题）。
 */

import { BRAND_NAME } from '@cindy/maker-shared/branding';
import { z } from 'zod';

import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { LiziMcpSessionContext } from '../types.js';
import { errorPayload, okPayload } from './_payload.js';
import { stringArrayParam } from './_array-param.js';

const MAX_LIST = 200;
const MAX_IMPORT = 500;

export interface SessionImportCandidateView {
  key: string;
  source: string;
  title: string;
  cwd: string | null;
  project: string | null;
  updatedAt: number;
  archived: boolean;
  sizeBytes: number;
  missingDir: boolean;
  hidden: string | null;
  unsupportedVersion: string | null;
}

export interface SessionImportScanView {
  candidates: SessionImportCandidateView[];
  hiddenCounts: Record<string, number>;
  sources: Array<{ id: string; label: string; count: number }>;
  sourceErrors: Array<{ id: string; message: string }>;
}

export interface SessionImportItemView {
  key: string;
  source: string;
  title: string;
  status: string;
  mode: string | null;
  harness: string | null;
  issue: string | null;
  sessionId: string | null;
  messagesWritten: number;
}

export interface SessionImportJobView {
  requestId: string;
  status: string;
  items: SessionImportItemView[];
}

export interface SessionImportCallbacks {
  scan(params: { force: boolean }): Promise<SessionImportScanView>;
  start(keys: string[]): Promise<SessionImportJobView>;
  status(requestId: string | null): Promise<SessionImportJobView | null>;
}

export interface SessionImportDeps {
  getSessionContext(): LiziMcpSessionContext;
  callbacks: SessionImportCallbacks;
}

const SCOPE = '仅本机：只扫描、导入当前这台电脑上的记录。';

function errorOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function summarizeJob(job: SessionImportJobView): Record<string, unknown> {
  const count = (s: string) => job.items.filter((it) => it.status === s).length;
  return {
    request_id: job.requestId,
    status: job.status,
    counts: {
      total: job.items.length,
      ready: count('ready'),
      needs_action: count('action'),
      failed: count('failed'),
      cancelled: count('cancelled'),
      pending: count('queued') + count('running'),
    },
    items: job.items.map((it) => ({
      key: it.key,
      source: it.source,
      title: it.title,
      status: it.status,
      continue_mode: it.mode,
      harness: it.harness,
      issue: it.issue,
      session_id: it.sessionId,
      messages_written: it.messagesWritten,
    })),
  };
}

export function registerSessionImportTools(registry: XdtHelperToolRegistry, deps: SessionImportDeps): void {
  registry.register({
    name: 'scan_importable_sessions',
    category: 'control',
    description:
      `列出这台电脑上其他 AI 编程工具（Claude Code、Codex、Pi、OpenCode、Gemini CLI、Cursor、Qwen Code、Kimi Code、Factory、WorkBuddy、DeepSeek Harness）里可以导入 ${BRAND_NAME} 继续做的任务。` +
      '只读扫描，不写任何数据。默认不列 Cindy 自己运行过的、临时文件夹里的、Agent 内部会话和已导入的，数量见 hidden_counts；include_hidden 可把前两类也列出来。' +
      '结果按更新时间倒序，用 key 调 import_sessions。' + SCOPE,
    inputShape: {
      source: z.string().optional().describe('只看某个来源（claude / codex / pi / opencode / gemini / cursor / qwen / kimi / factory / workbuddy / deepseek）'),
      project_dir: z.string().optional().describe('只看这个项目文件夹（worktree 归到主仓库）'),
      query: z.string().optional().describe('按标题或文件夹关键词过滤'),
      include_hidden: z.boolean().optional().describe('同时列出 Cindy 自己运行过的与临时文件夹里的任务'),
      force: z.boolean().optional().describe('忽略 30 秒内的扫描缓存重新扫描'),
      limit: z.number().int().min(1).max(MAX_LIST).optional().describe(`最多返回条数，默认 50，最多 ${MAX_LIST}`),
    },
    handler: async ({ source, project_dir, query, include_hidden, force, limit }) => {
      let scan: SessionImportScanView;
      try {
        scan = await deps.callbacks.scan({ force: force === true });
      } catch (err) {
        return errorPayload('SCAN_FAILED', `扫描失败：${errorOf(err)}。可以稍后重试。`);
      }
      const kw = query?.trim().toLowerCase() ?? '';
      const dir = project_dir?.trim().replace(/[\\/]+$/, '').toLowerCase() ?? '';
      const matched = scan.candidates
        .filter((c) => (include_hidden ? c.hidden !== 'internal' : !c.hidden))
        .filter((c) => !source || c.source === source)
        .filter((c) => !dir || (c.project ?? '').toLowerCase() === dir || (c.cwd ?? '').toLowerCase().startsWith(dir))
        .filter((c) => !kw || c.title.toLowerCase().includes(kw) || (c.cwd ?? '').toLowerCase().includes(kw))
        .sort((a, b) => b.updatedAt - a.updatedAt);
      const max = limit ?? 50;
      return okPayload({
        scope: 'local',
        total: matched.length,
        truncated: matched.length > max,
        candidates: matched.slice(0, max).map((c) => ({
          key: c.key,
          source: c.source,
          title: c.title,
          cwd: c.cwd,
          updated_at: new Date(c.updatedAt).toISOString(),
          archived: c.archived,
          size_bytes: c.sizeBytes,
          ...(c.missingDir ? { missing_dir: true } : {}),
          ...(c.hidden ? { hidden: c.hidden } : {}),
          ...(c.unsupportedVersion ? { unsupported_version: c.unsupportedVersion } : {}),
        })),
        hidden_counts: scan.hiddenCounts,
        sources: scan.sources,
        source_errors: scan.sourceErrors,
      });
    },
  });

  registry.register({
    name: 'import_sessions',
    category: 'control',
    description:
      `把 scan_importable_sessions 列出的任务导入 ${BRAND_NAME}（复制历史，不改动原记录），在后台进行，立即返回 request_id。` +
      'Claude Code / Codex / Pi 的任务原样续做，其它来源由默认引擎接着做（导入后可随时换）。已导入过的会跳过。' +
      '用 get_session_import_status 查进度与结果；格式不支持或原文件夹不存在的项会在结果里写明。' + SCOPE,
    inputShape: {
      keys: stringArrayParam(z.array(z.string().min(3).max(600)).min(1).max(MAX_IMPORT))
        .describe('scan_importable_sessions 返回的 key'),
    },
    handler: async ({ keys }) => {
      if (!deps.getSessionContext().sessionId) {
        return errorPayload('NO_SESSION_CONTEXT', `本次调用没有绑定 ${BRAND_NAME} 任务，无法导入。`);
      }
      try {
        const job = await deps.callbacks.start([...new Set(keys)]);
        return okPayload({ scope: 'local', ...summarizeJob(job) });
      } catch (err) {
        return errorPayload('IMPORT_FAILED', `没能开始导入：${errorOf(err)}。先用 scan_importable_sessions 确认 key 仍然有效。`);
      }
    },
  });

  registry.register({
    name: 'get_session_import_status',
    category: 'control',
    description:
      '查一次任务导入的进度与逐项结果：ready 可以继续（continue_mode=native 原样续做 / handoff 由 harness 接着做），' +
      'action 需要用户处理（原文件夹不存在），failed 附 issue。不传 request_id 返回最近一次导入。' + SCOPE,
    inputShape: {
      request_id: z.string().min(1).optional().describe('import_sessions 返回的 request_id'),
    },
    handler: async ({ request_id }) => {
      try {
        const job = await deps.callbacks.status(request_id ?? null);
        if (!job) return errorPayload('NOT_FOUND', '没有找到这次导入（可能已超过 7 天被清理）。');
        return okPayload({ scope: 'local', ...summarizeJob(job) });
      } catch (err) {
        return errorPayload('INTERNAL', `读取导入进度失败：${errorOf(err)}。`);
      }
    },
  });
}
