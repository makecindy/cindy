/**
 * Runner 共享工具 — schedule runner 共用的本地执行辅助。
 *
 * 抽取的目的：避免重复代码（CLAUDE.md §5），同时保证 session 生命周期相关逻辑
 * 在所有 runner 间一致（permission_mode/effort backfill、等待 turn 完成 + 超时 abort）。
 */

import { eq } from 'drizzle-orm';

import { isTerminalAgentErrorEvent } from '@cindy/maker-core';
import type { Session, AgentEvent } from '@cindy/maker-core';
import type { Logger } from '@cindy/maker-scheduler';

import { sessions as sessionsTable } from '../../localDb/schema';
import type { SchedulerDrizzleDb } from '../storage';
import {
  cancelReleasedOutput,
  onReleasedAgentEvent,
} from '../../content-moderation/outputHub.js';

/**
 * 修正 runner 新建 sessions 行的 metadata 列。
 *
 * 背景：DesktopSessionStorage.create() 硬编码 permissionMode='ask' / effort='high'，
 * 不读 createSession 入参（SessionMeta 接口本身不含这两字段）。
 * Runner 是 unattended 场景，必须强制 'bypassPermissions' + 用户填的 effort，
 * 否则 UI 上 model picker / permission picker 显示与 SDK 实际行为不符，反向欺诈。
 * workspaceKind/source 只在新建 schedule session 时传入；heartbeat 继续尊重既有
 * session，避免把用户手动创建的持续会话误标成自动化来源。
 *
 * 失败仅 warn，不中断 fire 流程。
 */
export interface BackfillSessionMetaPatch {
  effort?: string;
  /**
   * heartbeat 模式 schedule.model 覆盖了绑定 session 的旧 model 时落库，
   * 让 chat UI model picker 与下次 fire 读到的 meta.model 跟实际运行一致。
   * （DesktopSessionStorage 只在新建时写 model，复用已有 row 不更新。）
   */
  model?: string;
  /**
   * 任务级显式选了来源(供应商)时落 sessions.provider_id —— 让聊天里打开该会话时
   * 来源 picker 与下次 fire / 冷 resume 的路由一致(register hydrate funnel 读它)。
   * 留空(undefined)时不写,保留会话自己的 provider_id（heartbeat 沿用 / fresh 默认 null）。
   */
  providerId?: string;
  workspaceKind?: 'project' | 'dialogue';
  /** 自动化会话来源标记。learn-host 复用本函数落 'learn'(蒸馏 session)。 */
  source?: 'scheduler' | 'learn';
  /**
   * 落库的权限模式。缺省 'bypassPermissions'(scheduler unattended 语义不变);
   * learn-host 传 'acceptEdits' —— 蒸馏会话建会话时已降权,若这里放任默认值
   * 写回 bypass,app 重启后 lazy-resume 会按 sessions 行重建 createOpts,修订
   * 回合就逃出了降权约束(Codex review)。
   */
  permissionMode?: string;
}

export async function backfillSessionMeta(
  db: SchedulerDrizzleDb,
  sessionId: string,
  meta: BackfillSessionMetaPatch,
  logger: Logger,
): Promise<void> {
  try {
    const patch: Record<string, unknown> = {
      permissionMode: meta.permissionMode ?? 'bypassPermissions',
      updatedAt: Date.now(),
    };
    if (meta.effort) patch.effort = meta.effort;
    if (meta.model) patch.model = meta.model;
    if (meta.providerId) patch.providerId = meta.providerId;
    if (meta.workspaceKind) patch.workspaceKind = meta.workspaceKind;
    if (meta.source) patch.source = meta.source;
    await db.update(sessionsTable).set(patch).where(eq(sessionsTable.id, sessionId));
  } catch (err) {
    logger.warn?.(
      '[runner] backfill sessions metadata failed (non-fatal)',
      err,
    );
  }
}

export interface RunOneTurnResult {
  /** Agent 这一轮 turn 的最终文本（与飞书正常对话气泡显示同源）。 */
  assistantText: string;
  /** 完成时为 undefined；出错（含超时）时为错误信息。 */
  error?: string;
  /** 是否因超时触发 abort。 */
  timedOut?: boolean;
}

/**
 * 跑一个 agent turn 并收集最终文本。
 *
 * 行为：
 *   - 一次性 listener：done/终止型 error 任一立刻 unsubscribe（防泄漏）
 *   - text 事件按 isFinal 替换/追加 buffer（与飞书 runAgentTurn 同源语义）
 *   - 超时强制 abort session（停止烧 token）
 *   - 任何异常都被 catch 并以 error 字段返回，不抛
 *
 * 调用方应：
 *   1. 自己负责 session.send() 并把 user prompt 落库
 *   2. 自己处理 error 字段（决定 mark fail / retry / 其他）
 */
export async function runOneTurn(
  session: Session,
  timeoutMs: number,
  logger: Logger,
): Promise<RunOneTurnResult> {
  let assistantText = '';
  let timedOut = false;

  try {
    await new Promise<void>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        timedOut = true;
        off();
        // 超时强制 abort，agent 子进程会停止运行（不再烧 token）
        try {
          cancelReleasedOutput(session.id);
          void session.abort();
        } catch (err) {
          logger.warn?.('[runner] session.abort() on timeout failed', err);
        }
        reject(new Error(`timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      const off = onReleasedAgentEvent(session, (ev: AgentEvent) => {
        if (ev.type === 'text') {
          const data = ev.data as { text?: string; isFinal?: boolean } | null;
          if (data && typeof data.text === 'string') {
            if (data.isFinal) assistantText = data.text;
            else assistantText += data.text;
          }
          return;
        }
        if (ev.type === 'done') {
          clearTimeout(timeoutId);
          off();
          resolve();
        } else if (isTerminalAgentErrorEvent(ev)) {
          clearTimeout(timeoutId);
          off();
          const errData = ev.data as { message?: unknown } | null;
          reject(new Error(errData?.message ? String(errData.message) : 'agent error'));
        }
      });
    });
    return { assistantText };
  } catch (err) {
    return {
      assistantText,
      error: err instanceof Error ? err.message : String(err),
      timedOut,
    };
  }
}
