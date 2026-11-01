import {createBotWorkbenchTools} from '@cindy/app-runtime/botWorkbenchTools';
import * as transcripts from './botWorkbenchTranscripts.js';
import * as autonomyBridge from './botWorkbenchAutonomyBridge.js';
import * as responsibilities from './botTaskResponsibility.js';
import {createWorkbenchAuthority} from '@cindy/app-runtime/workbenchAuthority';
import {createWorkbenchCaller} from '@cindy/app-runtime/workbenchCaller';
/**
 * 伙伴工作台工具的宿主实现:把 `botWorkbenchAccess.ts` 的纯逻辑接到真实数据源上。
 *
 * - 伙伴身份从调用方 session 反查(只认本机、在用的伙伴主任务);
 * - 「一眼」与总调度身份读宿主观察层(`botWorkbenchAutonomyBridge.ts`),这里不另存状态;
 * - 逐任务责任读伙伴家的 task-responsibility 与它自己开的后台任务(bot_delegations);
 * - 继续复用宿主已有的发消息路径(本机 = send_to_session 同一条链路;另一台电脑 =
 *   跨电脑 send_to_session 的同一条通路),由调用方注入;停止走通用的 stop_session_turn。
 * 项目关联只提供按需阅读的入口，不按目录发现候选任务或导入本机外部会话。
 */
import { and, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { hasTaskActionAuthorization, assertTaskActionCurrent, captureTaskActionSyncGuard } from './taskActionAuthorization.js';

import { getDbClient } from '../localDb/client/current.js';
import { botDelegations, botProfiles, botSessionLinks, sessions } from '../localDb/schema.js';
import {
  activeOwnerScopeKey,
  isAppSessionBoundaryPending,
  ownerScopedUserDataPath,
} from '../appSessionState.js';
import type { WorkbenchDelegationStatus, WorkbenchTranscriptItem } from '../../shared/botWorkbench.js';
import { broadcastBotWorkbenchChanged } from './botWorkbenchService.js';
import { botLinkedProjectAccess } from './botLinkedProjects.js';
import { boundTranscript, readSessionTranscript } from './botWorkbenchTranscripts.js';
import { readTaskResponsibilities, responsibleSessionIds, setTaskResponsibility, collectTaskResponsibilityScopes } from './botTaskResponsibility.js';
import { readBotGlance, readSchedulerBotId, readWatchedSession } from './botWorkbenchAutonomyBridge.js';
import {
  createBotWorkbenchAccess,
  type BotWorkbenchAccess,
  type BotWorkbenchAccessDeps,
  type WorkbenchCallerResult,
  type WorkbenchTargetFacts,
} from './botWorkbenchAccess.js';

/** 伙伴主任务才能用工作台;远端、归档、非主任务一律拒绝。 */
export type {BotWorkbenchHostDeps} from '@cindy/app-runtime/botWorkbenchTools';
export const {resolveWorkbenchCaller,runBotProjectsTool,readBotResponsibleSessionIds,readBotResponsibilityScope,captureBotCreatedTaskResponsibility,runBotWorkbenchTool,readBotWorkbenchTaskForOwner,canBotContinueWorkbenchTask}=createBotWorkbenchTools({getDbClient:()=>getDbClient(),activeOwnerScopeKey,isAppSessionBoundaryPending,ownerScopedUserDataPath,broadcastBotWorkbenchChanged,botLinkedProjectAccess,...transcripts,...autonomyBridge,...responsibilities});
