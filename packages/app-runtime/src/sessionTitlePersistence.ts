import { and, eq } from "drizzle-orm";
import { sessions } from "@cindy/runtime-db/schema";
import {
  DEFAULT_DRAFT_SESSION_TITLE,
  normalizeAutoTitle,
} from "@cindy/maker-shared/session-title";
import type { OverwritableAutoTitleTarget } from "./sessionService.js";
import type { SessionServiceHost } from "./sessionServiceHost.js";
export type SessionTitleHost = Pick<
  SessionServiceHost<unknown>,
  | "getDbClient"
  | "selectSessionWithCount"
  | "sessionPatchToRow"
  | "sessionToCamel"
  | "notifyAgentIslandSessionPatch"
  | "captureOwnerScope"
  | "isOwnerScopeCurrent"
  | "broadcastSessionPatched"
>;
export function createSessionTitlePersistence(host: SessionTitleHost) {
  const {
    getDbClient,
    selectSessionWithCount,
    sessionPatchToRow,
    sessionToCamel,
    notifyAgentIslandSessionPatch,
    captureOwnerScope,
    isOwnerScopeCurrent,
    broadcastSessionPatched,
  } = host;
  /** fork 出来的会话的占位标题前缀("[Fork] …" / "[Fork·已剥离] …")。 */
  const FORK_PLACEHOLDER_TITLE_PREFIX = "[Fork";

  let _onUserTitleWritten: ((sessionId: string) => void) | null = null;

  /**
   * 注入「用户手动写过标题」的通知(传 null 清除;由 maker-ipc 的自动起名模块注册)。
   *
   * 为什么条件写不够:`persistSessionTitleIfStillDraft` 靠 `WHERE title = 期望值` 实现
   * user rename wins,但用户把标题改成**与占位逐字相同**的串时这条件仍然成立,随后的
   * 智能标题会把他刚保存的名字覆盖掉(PR #510 review P1)。`sessions` 表没有「谁写的」
   * 这一列,所以由改名出口显式说一声,自动起名据此收手。
   */
  function setOnUserSessionTitleWritten(
    fn: ((sessionId: string) => void) | null,
  ): void {
    _onUserTitleWritten = fn;
  }

  /** 用户改名出口统一调这个(自动起名自己的写入**不**调)。 */
  function noteUserTitleWritten(sessionId: string): void {
    try {
      _onUserTitleWritten?.(sessionId);
    } catch {
      // 自动起名是附属功能,通知失败不该影响改名主流程。
    }
  }

  async function getOverwritableAutoTitle(
    id: string,
    synthesizedPlaceholder?: string | null,
  ): Promise<OverwritableAutoTitleTarget | null> {
    const db = getDbClient().drizzle;
    const row = await selectSessionWithCount(db, id);
    if (!row) return null;
    const agentKind =
      row.agentKind === "codex" || row.agentKind === "pi"
        ? row.agentKind
        : "claude-code";
    const overwritable =
      row.title === DEFAULT_DRAFT_SESSION_TITLE ||
      (!!row.parentSessionId &&
        row.title.startsWith(FORK_PLACEHOLDER_TITLE_PREFIX)) ||
      (!!synthesizedPlaceholder && row.title === synthesizedPlaceholder);
    if (!overwritable) return null;
    return {
      title: row.title,
      agentKind,
      isDefaultDraftTitle: row.title === DEFAULT_DRAFT_SESSION_TITLE,
    };
  }

  /**
   * 布尔版资格检查(给 enqueue 前的廉价预检用)。真正执行起名的路径用
   * {@link getOverwritableAutoTitle},因为它还要拿当前标题当条件写的期望值 ——
   * fork 占位与合成占位都不等于草稿默认值,猜期望值会让写入直接落空。
   */
  async function isUntitledSessionAwaitingAutoTitle(
    id: string,
    synthesizedPlaceholder?: string | null,
  ): Promise<boolean> {
    return (
      (await getOverwritableAutoTitle(id, synthesizedPlaceholder)) !== null
    );
  }

  /**
   * 自动标题落库出口。只在 title 仍等于 `expectedTitle` 时写入,避免后台标题覆盖
   * 用户手动改名。
   *
   * `expectedTitle` 默认是草稿占位;远控立即占位链路在写完占位后,用占位串作为
   * 期望值再写智能标题——用户在等待窗口内手动改名时期望值不匹配,写入被拒绝。
   */
  async function persistSessionTitleIfStillDraft(
    sessionId: string,
    title: string,
    expectedTitle: string = DEFAULT_DRAFT_SESSION_TITLE,
  ): Promise<boolean> {
    const ownerScope = captureOwnerScope();
    const cleanTitle = normalizeAutoTitle(title);
    if (!cleanTitle || cleanTitle === DEFAULT_DRAFT_SESSION_TITLE) return false;

    const db = getDbClient().drizzle;
    // 目标值与期望值相同 → UPDATE 无事可做,但**不能凭期望值直接报成功**:期望值
    // 可能已经过期(用户在资格检查之后手动改了名),那时库里根本不是这个标题。
    // 读一次真实标题再回答,避免调用方把"没写成"当成"已写入"(PR #510 review)。
    if (cleanTitle === expectedTitle) {
      const current = await selectSessionWithCount(db, sessionId);
      return !!current && current.title === cleanTitle;
    }

    const setObj = sessionPatchToRow(
      { title: cleanTitle },
      { bumpUpdatedAt: false },
    );
    await db
      .update(sessions)
      .set(setObj)
      .where(
        and(eq(sessions.id, sessionId), eq(sessions.title, expectedTitle)),
      );

    const row = await selectSessionWithCount(db, sessionId);
    if (!row || row.title !== cleanTitle) return false;

    const updated = sessionToCamel(row);
    notifyAgentIslandSessionPatch(updated.id, {
      status: updated.status,
      title: updated.title,
      workingDir: updated.workingDir,
      workspaceKind: updated.workspaceKind,
    });
    if (isOwnerScopeCurrent(ownerScope)) {
      broadcastSessionPatched(sessionId, { title: cleanTitle }, ownerScope);
    }
    return true;
  }

  return {
    setOnUserSessionTitleWritten,
    noteUserTitleWritten,
    getOverwritableAutoTitle,
    isUntitledSessionAwaitingAutoTitle,
    persistSessionTitleIfStillDraft,
  };
}
