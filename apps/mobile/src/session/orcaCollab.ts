/**
 * 手机端 Orca 协同(桌面 Lead/worker 团队)消息识别与卡片建模 —— 纯 mobile render 层。
 *
 * 聚焦的"Lead 会话"在消息流里有两类协同消息需要识别并渲染成卡片(否则会糊一坨原始 JSON / 生硬的
 * tool 名给用户看):
 *  - **派活**:Lead 调用 `create_worker` / `create_workers` / `send_to_worker`(tool_use)给 worker 派活。
 *  - **回报**:worker 的 `send_to_lead` 落库成一条 `role==='user'` 消息,content 是
 *    `{"orcaSource":"worker","content":"…"}` 的 JSON(DB 持久化格式)。
 *
 * 这里只做"识别 + 抽取展示文案",真正渲染在 MessageRenderer 的 OrcaCollabCard。匹配 tool 名沿用
 * 共享层 `isOrcaCommunicationTool` 的归一化约定(`mcp__X__Y` → `mcp:X:Y`),兼容裸名与 MCP 前缀名。
 */

import { i18n } from '@/i18n';

export interface OrcaCollabCard {
  /** dispatch = Lead 派活;report = worker 回报。用于卡片视觉/标题区分。 */
  variant: 'dispatch' | 'report';
  /** 卡片标题,如 "派活给 worker frontend" / "worker 回报"。 */
  title: string;
  /** 卡片正文:派活的任务摘要 / 回报的正文内容。 */
  body: string;
}

function normalizeToolName(toolName: string): string {
  return toolName.replace(/^mcp__/, 'mcp:').replace(/__/g, ':');
}

/** 识别 Lead 派活类 tool:单建、批量新建与追加派活。 */
export function classifyOrcaDispatchTool(toolName: string): 'create' | 'create-batch' | 'send' | null {
  const normalized = normalizeToolName(toolName);
  if (normalized === 'create_worker' || normalized.endsWith(':create_worker')) return 'create';
  if (normalized === 'create_workers' || normalized.endsWith(':create_workers')) return 'create-batch';
  if (normalized === 'send_to_worker' || normalized.endsWith(':send_to_worker')) return 'send';
  return null;
}

/** 从派活 tool_use 的输入里抽出"派活给谁 + 任务摘要",建模成 dispatch 卡片;非派活 tool 返回 null。 */
export function buildOrcaDispatchCard(toolName: string, input: unknown): OrcaCollabCard | null {
  const kind = classifyOrcaDispatchTool(toolName);
  if (!kind) return null;
  const record = readRecord(input);

  if (kind === 'create-batch') {
    const workers = Array.isArray(record?.workers) ? record.workers : [];
    const summaries = workers.map((value, index) => {
      const worker = readRecord(value);
      const label = readString(worker?.label) ?? readString(worker?.role) ?? `worker ${index + 1}`;
      const task = readString(worker?.initial_task);
      return task ? i18n.t('interaction.collab.dispatchSummaryItem', { label, task }) : label;
    });
    return {
      variant: 'dispatch',
      title: workers.length > 0
        ? i18n.t('interaction.collab.batchTitle', { count: workers.length })
        : i18n.t('interaction.collab.batchTitleGeneric'),
      body: summaries.length > 0 ? summaries.join('\n') : i18n.t('interaction.collab.batchBodyFallback'),
    };
  }

  if (kind === 'create') {
    const label = readString(record?.label);
    const role = readString(record?.role);
    const agent = readString(record?.agent);
    const task = readString(record?.initial_task);
    const who = label ?? role ?? 'worker';
    const meta = [role, agent].filter(Boolean).join(' · ');
    return {
      variant: 'dispatch',
      title: i18n.t('interaction.collab.dispatchTitle', { who }),
      body: task ?? (meta ? i18n.t('interaction.collab.dispatchRole', { meta }) : i18n.t('interaction.collab.dispatchBodyFallback')),
    };
  }

  // send_to_worker:只有 target_session_id + message,没有 label,标题用通用文案。
  const message = readString(record?.message);
  const target = readString(record?.target_session_id);
  return {
    variant: 'dispatch',
    title: i18n.t('interaction.collab.sendTitle'),
    body: message ?? (target ? `→ ${target}` : i18n.t('interaction.collab.sendBodyFallback')),
  };
}

/**
 * 解析 worker 回报消息(user 消息 content = `{orcaSource:'worker',content}`)。
 * 命中则建模成 report 卡片;**解析失败 / 非该格式一律返回 null**,由调用方回退普通文本,绝不把原始
 * JSON 糊给用户看。
 */
export function parseOrcaWorkerReport(content: unknown): OrcaCollabCard | null {
  const record = parseMaybeJsonObject(content);
  if (!record || record.orcaSource !== 'worker') return null;
  const body = readString(record.content);
  return {
    variant: 'report',
    title: i18n.t('interaction.collab.reportTitle'),
    body: body ?? i18n.t('interaction.collab.reportBodyFallback'),
  };
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseMaybeJsonObject(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try {
      return readRecord(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return readRecord(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}
