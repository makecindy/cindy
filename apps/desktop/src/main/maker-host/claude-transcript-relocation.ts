/**
 * 会话移动(workingDir 变更)时的 Claude CLI 转录迁移编排。
 *
 * CLI 按「会话 cwd 转码目录」存取转录(resume / rewind-fork 皆是),xdt-maker
 * 改会话 workingDir 后必须把转录复制到新 cwd 的转码目录,否则下一次 resume 报
 * "No conversation found with session ID"(2026-07 实测事故:对话移动到项目后
 * 无法续聊)。文件迁移本体在 maker-core(relocateClaudeSessionTranscripts)。
 *
 * 本模块的编排顺序(每一步的先后都有讲究,详见函数内注释):
 *   1. 取活跃会话内存中的 sdkSessionId(过滤 '<pending>' 占位符)—— rewind fork
 *      后、消息落库前 DB 停在旧值(事故正是该窗口),必须在关闭 handle 前取;
 *   2. 读走 DB 里的旧 sdk_session_id —— 必须在被覆盖前读,它可能不在 messages
 *      meta 里,漏了它对应的转录就不会被复制;
 *   3. 把内存 id 持久化回 sessions.sdk_session_id —— handle 关闭后下一次 send
 *      走 lazy-create、resume 用的是 DB 值,不持久化会 resume 到旧 fork 丢上下文;
 *   4. 关闭活跃 handle(Maker.closeSession,幂等)—— 否则旧 cwd 的 CLI 进程
 *      继续服务后续 send、新 turn 追加进旧目录 jsonl,新目录副本停在移动时刻,
 *      重启后 resume 读到过期副本(PR #472 Codex review 指出的分叉窗口);
 *      关闭也保证 CLI flush 完 jsonl,复制拿到完整内容;
 *   5. 内存 id + DB 旧 id + messages agent_meta 的 DISTINCT sdkSessionId
 *      (rewind fork 历史链)三源并集交给 maker-core 复制。
 *
 * 整体 best-effort:任何失败只记日志,不阻断会话移动主流程(转录可事后手工
 * 迁移,移动失败对用户伤害更大)。
 */
import path from 'node:path';

import { relocateClaudeSessionTranscripts } from '@cindy/maker-core';

import { getDbClient } from '../localDb/client/current.js';
import type { DbClient } from '../localDb/client/DbClient.js';
import { createLogger } from '../logger.js';
import { defaultClaudeConfigDirCandidates } from '../maker-orchestration/claudeTranscriptAnchors.js';

const log = createLogger('claude-transcript-relocation');

/** 活跃会话桥:查内存 sdkSessionId + 关闭 handle;register 阶段由 maker 实例注入。 */
export interface LiveCcSessionBridge {
  /** 返回该 xdt session 活跃 handle 当前的 sdkSessionId;无活跃 handle 返回 null。 */
  resolveSdkSessionId(sessionId: string): string | null;
  /** 优雅关闭该 xdt session 的活跃 handle(无 handle 时应为 no-op)。 */
  closeSession(sessionId: string): Promise<void>;
}

let liveCcSessionBridge: LiveCcSessionBridge | null = null;

/**
 * 注入活跃会话桥。与 anthropic-compat-proxy-host 的 setClaudeProxySessionIdResolver
 * 同款模式:避免 localDb → maker-ipc 的静态模块环,maker 实例只在 register 阶段可得。
 */
export function setLiveCcSessionBridge(bridge: LiveCcSessionBridge | null): void {
  liveCcSessionBridge = bridge;
}

/**
 * 内存 sdkSessionId 是否为已回填的真实 SDK id。SDK 尚未回填时 handle.id 是
 * '<pending>' 占位符(见 maker-core session.ts sdkSessionId getter),持久化
 * 占位符会污染 DB 的 resume 链路,必须过滤。
 */
function isRealSdkSessionId(id: string | null): id is string {
  return !!id && /^[0-9a-fA-F-]{20,}$/.test(id);
}

/**
 * 查 messages.agent_meta 里该会话历史上出现过的全部 sdkSessionId(rewind fork 链)。
 * json_valid 守卫:历史消息可能带坏 JSON 的 agent_meta(其它读路径同样容忍解析
 * 失败),不守卫的话 json_extract 抛 malformed JSON 会让整次迁移被外层吞掉;
 * meta 只是补充来源,查询失败也不应拖垮核心迁移(DB id + 内存 id 已覆盖 resume)。
 */
async function listMetaSdkSessionIds(sessionId: string, client?: DbClient): Promise<string[]> {
  try {
    const metaRows = await (client ?? getDbClient()).query<{ sid: string | null }>(
      `SELECT DISTINCT json_extract(agent_meta, '$.sdkSessionId') AS sid
       FROM messages
       WHERE session_id = ? AND agent_meta IS NOT NULL AND json_valid(agent_meta)`,
      [sessionId],
    );
    // typeof 守卫:合法 JSON 里 sdkSessionId 也可能是非字符串(导入 / 部分损坏数据),
    // 放行会让下游 id.trim() 抛错拖垮整次迁移。
    return metaRows
      .map((row) => row.sid)
      .filter((sid): sid is string => typeof sid === 'string' && sid.length > 0);
  } catch (err) {
    log.warn('listMetaSdkSessionIds failed, relocating with DB/live ids only', { sessionId, err });
    return [];
  }
}

export interface ClaudeSdkSessionIdSet {
  /** 三源并集(内存 live id + DB sdk_session_id + messages agent_meta 历史链)。 */
  ids: string[];
  /** resume 实际会用的 id:live 领先 DB 时取 live,否则取 DB;都无则 null。 */
  activeId: string | null;
}

/**
 * 会话分享导出:收集一个 cc 会话全部相关 sdkSessionId(与迁移编排同款三源并集)。
 * 与 relocateClaudeTranscriptsForSessionMove 的关键差别:**只读**——不持久化
 * live id、更不关闭活跃 handle(导出是快照语义,会话可以继续跑)。
 */
export async function collectClaudeSdkSessionIds(sessionId: string): Promise<ClaudeSdkSessionIdSet> {
  const rawLiveId = liveCcSessionBridge?.resolveSdkSessionId(sessionId) ?? null;
  const liveId = isRealSdkSessionId(rawLiveId) ? rawLiveId : null;
  const rawDbId =
    (
      await getDbClient().queryOne<{ sdkSessionId: string | null }>(
        'SELECT sdk_session_id AS sdkSessionId FROM sessions WHERE id = ? LIMIT 1',
        [sessionId],
      )
    )?.sdkSessionId ?? null;
  // 三源全部过 isRealSdkSessionId:导入/损坏数据可能让 DB 行或 agent_meta 里
  // 混进带路径成分的字符串,下游会拿 id 拼文件系统路径与 zip 内路径,必须
  // 与 live id 同口径过滤(review bot 指出)。
  const dbId = isRealSdkSessionId(rawDbId) ? rawDbId : null;
  const ids = new Set<string>([liveId, dbId].filter((id): id is string => !!id));
  for (const sid of await listMetaSdkSessionIds(sessionId)) {
    if (isRealSdkSessionId(sid)) ids.add(sid);
  }
  return { ids: [...ids], activeId: liveId ?? dbId };
}

export interface RelocateForSessionMoveResult {
  /** 迁移过程中被持久化进 sessions.sdk_session_id 的内存 id(未发生持久化时为 null)。
   *  调用方(sessions:update handler)须把它并入返回行 / 广播 patch,否则 renderer
   *  会拿着旧 resume id 继续跑(PR #472 Codex review 指出)。 */
  persistedSdkSessionId: string | null;
}

/**
 * 会话 workingDir 变更后迁移其 Claude CLI 转录(编排顺序见文件头注释)。
 * 仅限本机 cc 会话调用(调用方负责过滤 agentKind / remoteHostId)。不抛错。
 */
export async function relocateClaudeTranscriptsForSessionMove(
  sessionId: string,
  oldWorkingDir: string,
  newWorkingDir: string,
  scope?: { client: DbClient; assertCurrent: () => void },
): Promise<RelocateForSessionMoveResult> {
  let persistedSdkSessionId: string | null = null;
  try {
    scope?.assertCurrent();
    const client = scope?.client ?? getDbClient();
    const bridge = liveCcSessionBridge;
    const projectsRoot = path.join(defaultClaudeConfigDirCandidates()[0], 'projects');
    // 1. 内存 id 必须在关闭 handle 前取;SDK 未回填时是 '<pending>' 占位符,过滤掉
    //    (占位符不持久化、不参与迁移,但 handle 本身仍要关——它连的是旧 cwd)。
    const rawLiveId = bridge?.resolveSdkSessionId(sessionId) ?? null;
    const liveId = isRealSdkSessionId(rawLiveId) ? rawLiveId : null;

    // 2. DB 旧 id 必须在被覆盖前读走——它可能不在 messages meta 里(消息未落库),
    //    先 UPDATE 再读会把它从迁移集合里漏掉(PR #472 Greptile review 指出)。
    const dbId =
      (
        await client.queryOne<{ sdkSessionId: string | null }>(
          'SELECT sdk_session_id AS sdkSessionId FROM sessions WHERE id = ? LIMIT 1',
          [sessionId],
        )
      )?.sdkSessionId ?? null;

    // 3. 内存 id 领先 DB 时持久化——handle 关闭后 lazy-create resume 只认 DB 值。
    scope?.assertCurrent();
    if (liveId && liveId !== dbId) {
      await client.exec('UPDATE sessions SET sdk_session_id = ? WHERE id = ?', [
        liveId,
        sessionId,
      ]);
      persistedSdkSessionId = liveId;
    }

    // 4. 关闭活跃 handle:让 CLI flush 落盘,并杜绝旧 cwd 进程继续追加旧目录
    //    jsonl 造成的新旧目录分叉;下一次 send 以新 workingDir lazy-create resume。
    scope?.assertCurrent();
    if (bridge) {
      await bridge.closeSession(sessionId);
    }

    const ids = new Set<string>([liveId, dbId].filter((id): id is string => !!id));
    scope?.assertCurrent();
    for (const sid of await listMetaSdkSessionIds(sessionId, client)) ids.add(sid);
    scope?.assertCurrent();
    const sdkSessionIds = [...ids];
    if (sdkSessionIds.length === 0) {
      log.debug('transcript relocation skipped: no sdk session ids', { sessionId });
      return { persistedSdkSessionId };
    }
    // projectsRoot 必须与 CLI 子进程实际使用的配置目录一致(候选首项:显式
    // CLAUDE_CONFIG_DIR,否则默认 ~/.claude;dev 多实例也一样)。旧版 dev 隔离目录里
    // 尚未补拷的转录不在这里搬:下次拉起 CLI 前先补拷到默认目录,再由 resume 前的
    // 转录归位全局扫描放进新 cwd。
    const result = await relocateClaudeSessionTranscripts({
      sdkSessionIds,
      oldWorkingDir,
      newWorkingDir,
      projectsRoot,
    });
    if (result.targetKeyInexact) {
      log.warn('transcript relocation skipped: target project key inexact (path too long)', {
        sessionId,
        newWorkingDir,
      });
      return { persistedSdkSessionId };
    }
    const level = result.missing.length > 0 ? 'warn' : 'info';
    log[level]('relocated Claude transcripts for session move', {
      sessionId,
      oldWorkingDir,
      newWorkingDir,
      liveId,
      copied: result.copied,
      replaced: result.replaced,
      skipped: result.skipped,
      missing: result.missing,
    });
    return { persistedSdkSessionId };
  } catch (err) {
    log.warn('transcript relocation failed (session move proceeds)', {
      sessionId,
      oldWorkingDir,
      newWorkingDir,
      err,
    });
    // 失败也要如实上报已发生的持久化——DB 已改,renderer 状态必须跟上。
    return { persistedSdkSessionId };
  }
}
