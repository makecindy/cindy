import { app } from 'electron';
import { eq } from 'drizzle-orm';

import type { MakerSessionCreateOpts } from './sessionRequest.js';
import { ensureBotWorkspaceDir } from './botProfileFolder.js';
import { getDbClient } from '../localDb/client/current.js';
import { botSessionLinks } from '../localDb/schema.js';
import { ownerScopedUserDataPath } from '../appSessionState.js';

export interface BotWorkspaceRuntimeDeps {
  ensureWorkspaceDir?: typeof ensureBotWorkspaceDir;
  ownerUserDataPath?: () => string;
  legacyUserDataPath?: () => string;
}

/**
 * `prepareStartOptions` 生命周期钩子在每次 session 启动/恢复时都会调用本函数——
 * 不只是 Bot session。这里只做一件事：如果这个 session 挂在某个 Bot 名下
 * （`bot_session_links` 有匹配行），把 `opts.workingDir` 收敛到该 Bot 的
 * Bot Home「workspace/」目录（`ensureBotWorkspaceDir`，与创建期 `bots.ts`／
 * delegation 走的是同一个解析函数，本调用是幂等自愈，防用户手动删了目录）。
 * 非 Bot session 直接原样返回，不做任何改动。
 *
 * 旧版这里还挂着 per-task lease／worktree／远端 host／project-binding 的一整套
 * 状态机；那些表（bot_workspace_leases 等）已随 Section A 的整体裁剪删除，
 * 创建期也早已直接调用 `ensureBotWorkspaceDir`，所以这里不再需要重建等价逻辑。
 */
export async function prepareBotWorkspaceRuntime(
  opts: MakerSessionCreateOpts,
  deps: BotWorkspaceRuntimeDeps = {},
): Promise<void> {
  const sessionId = opts.id;
  if (!sessionId) return;

  const db = getDbClient().drizzle;
  const link = await db
    .select({ botId: botSessionLinks.botId })
    .from(botSessionLinks)
    .where(eq(botSessionLinks.sessionId, sessionId))
    .limit(1);
  const botId = link[0]?.botId;
  if (!botId) return;

  const ensureWorkspaceDir = deps.ensureWorkspaceDir ?? ensureBotWorkspaceDir;
  const ownerUserDataPath = deps.ownerUserDataPath ?? ownerScopedUserDataPath;
  const legacyUserDataPath = deps.legacyUserDataPath ?? (() => app.getPath('userData'));

  const workingDir = await ensureWorkspaceDir(ownerUserDataPath(), botId, legacyUserDataPath());
  opts.workingDir = workingDir;
  opts.workspaceKind = 'dialogue';
  opts.remoteHostId = undefined;
}
