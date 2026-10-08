import { stat } from 'node:fs/promises';

import { app } from 'electron';
import { eq } from 'drizzle-orm';

import type { MakerSessionCreateOpts } from './sessionRequest.js';
import { ensureBotChatOnlyWorkspaceDir, ensureBotWorkspaceDir } from './botProfileFolder.js';
import { getDbClient } from '../localDb/client/current.js';
import { botGroupPlans, botSessionLinks, sessions } from '../localDb/schema.js';
import { ownerScopedUserDataPath } from '../appSessionState.js';
import { botGroupPlanRouteKey, isChatOnlyGroupLane, parseBotGroupPlanRouteKey } from '../../shared/botGroupChat.js';

export interface BotWorkspaceRuntimeDeps {
  ensureWorkspaceDir?: typeof ensureBotWorkspaceDir;
  ownerUserDataPath?: () => string;
  legacyUserDataPath?: () => string;
  isDirectory?: (dir: string) => Promise<boolean>;
}

export class BotPlanWorkDirUnavailableError extends Error {
  readonly code = 'BOT_GROUP_WORKDIR_UNAVAILABLE';
  constructor() {
    super('分工的工作目录不可用');
  }
}

async function isExistingDirectory(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * `prepareStartOptions` 生命周期钩子在每次 session 启动/恢复时都会调用本函数——
 * 不只是 Bot session。这里只做一件事：如果这个 session 挂在某个 Bot 名下
 * （`bot_session_links` 有匹配行），把 `opts.workingDir` 收敛到该 Bot 的
 * Bot Home「workspace/」目录（`ensureBotWorkspaceDir`，与创建期 `bots.ts`／
 * delegation 走的是同一个解析函数，本调用是幂等自愈，防用户手动删了目录）。
 * 非 Bot session 直接原样返回，不做任何改动。
 *
 * 群分工在已登记的工作目录里干活：旧本地计划读取 `bot_group_plans.work_dir`，
 * 服务端计划读取建专线时持久化的 `sessions.working_dir`，不要求本地计划行。
 * 目录不可用直接失败，绝不回退到 Home。仅聊天授权优先于分工规则，每次启动都
 * 收敛到按账号、伙伴和授权专线隔离的聊天目录，不读取项目或 Home。
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
    .select({ botId: botSessionLinks.botId, role: botSessionLinks.role, routeKey: botSessionLinks.routeKey })
    .from(botSessionLinks)
    .where(eq(botSessionLinks.sessionId, sessionId))
    .limit(1);
  const botId = link[0]?.botId;
  if (!botId) return;

  const ownerUserDataPath = deps.ownerUserDataPath ?? ownerScopedUserDataPath;
  const groupRouteKey = link[0]?.role === 'group' ? link[0].routeKey : null;
  if (isChatOnlyGroupLane(groupRouteKey)) {
    opts.workingDir = await ensureBotChatOnlyWorkspaceDir(ownerUserDataPath(), botId, groupRouteKey!);
    opts.workspaceKind = 'dialogue';
    opts.remoteHostId = undefined;
    return;
  }

  const planRoute = parseBotGroupPlanRouteKey(groupRouteKey);
  if (planRoute) {
    let workDir: string | null | undefined;
    if (groupRouteKey === botGroupPlanRouteKey(planRoute.groupId, planRoute.planId)) {
      const [plan] = await db
        .select({ groupId: botGroupPlans.groupId, workDir: botGroupPlans.workDir })
        .from(botGroupPlans)
        .where(eq(botGroupPlans.id, planRoute.planId))
        .limit(1);
      workDir = plan && plan.groupId === planRoute.groupId ? plan.workDir : null;
    } else {
      // A server plan's local workspace is recorded when its access-scoped lane
      // is created. Never resolve a coincidentally matching legacy plan id.
      const [session] = await db.select({ workingDir: sessions.workingDir })
        .from(sessions).where(eq(sessions.id, sessionId)).limit(1);
      workDir = session?.workingDir;
    }
    const isDirectory = deps.isDirectory ?? isExistingDirectory;
    if (!workDir || !(await isDirectory(workDir))) throw new BotPlanWorkDirUnavailableError();
    opts.workingDir = workDir;
    opts.workspaceKind = 'project';
    opts.remoteHostId = undefined;
    return;
  }

  const ensureWorkspaceDir = deps.ensureWorkspaceDir ?? ensureBotWorkspaceDir;
  const legacyUserDataPath = deps.legacyUserDataPath ?? (() => app.getPath('userData'));

  const workingDir = await ensureWorkspaceDir(ownerUserDataPath(), botId, legacyUserDataPath());
  opts.workingDir = workingDir;
  opts.workspaceKind = 'dialogue';
  opts.remoteHostId = undefined;
}
