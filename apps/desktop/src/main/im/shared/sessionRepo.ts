import { toCoreAgentKind, type ImSessionRow, type SessionModelRouteSnapshot, type ImSessionRepo } from '@cindy/im-runtime/sessionRepo';
export { toCoreAgentKind, type ImSessionRow, type SessionModelRouteSnapshot, type ImSessionRepo } from '@cindy/im-runtime/sessionRepo';
/**
 * main/im/shared/sessionRepo.ts
 * ---------------------------------------------------------------------------
 * IM 渠道的 sessions DB 层(渠道无关)。`sessions` 表与 desktop UI 会话共用
 * (见 localDb/schema.ts);按渠道路由查找/创建属于 (botContextId, userId) 的
 * 会话行。大多数渠道沿用确定性 id；Telegram `/new` 会轮换成新的任务 id。
 * 渠道差异(id 格式 / source 列值 / 默认 title / workingDir 策略 / 渠道专属列)
 * 收敛在 ImSessionNamespace, 由 adapter 注入。
 *
 * Manual INSERT (不走 maker 的 DesktopSessionStorage.create) — 为了预填渠道
 * 专属列。Maker 的 `createSession({ id })` 经 storage.get() 看到行已存在,
 * 只附加 SDK handle。
 */

import { randomUUID } from 'node:crypto';

import { and, desc, eq, sql } from 'drizzle-orm';
import type { IdentityKey } from '@cindy/im';
import type { AgentKind, Effort, PermissionMode } from '@cindy/maker-core';
import type { ProviderView } from '@cindy/model-providers';
import { permissionModeOrAsk } from '@cindy/maker-shared/permission-mode';

import { getDbClient } from '../../localDb/client/current';
import { normalizeDbAgentKind } from '../../../shared/agentKindConversion';
import { sessions } from '../../localDb/schema';
import { withSessionRouteLock } from '../../localDb/sessionRouteLock';
import { retireDeletedPiSubagentState } from '../../localDb/ipc/piSubagentDeletion';
import { createLogger, maskPath } from '../../logger';
import { setSessionProvider } from '../../maker-host/session-provider-store';
import {
  getImDefaultEffortFor,
  resolveImSessionDefaults,
  type ResolvedImSessionDefaults,
} from '../defaultSessionSettings';
import { buildImDefaultRouteRecord } from './channelDefaultRoute';
import { broadcastSessionCreated, broadcastSessionPatched } from './sessionBroadcast';
import { captureChannelAccount, openChannelSession } from './openChannelSession';
import type { ImOrchestratorConfig, ImSessionNamespace } from './types';


import {createImSessionRepository} from '@cindy/app-runtime/imSessionRepository';
const runtime=createImSessionRepository({
 getDbClient:(...args)=>getDbClient(...args),withSessionRouteLock:(...args)=>withSessionRouteLock(...args),
 retireDeletedPiSubagentState:(...args)=>retireDeletedPiSubagentState(...args),createLogger,maskPath,
 setSessionProvider:(...args)=>setSessionProvider(...args),getImDefaultEffortFor:(...args)=>getImDefaultEffortFor(...args),
 resolveImSessionDefaults:(...args)=>resolveImSessionDefaults(...args),
 broadcastSessionCreated:(...args)=>broadcastSessionCreated(...args),broadcastSessionPatched:(...args)=>broadcastSessionPatched(...args),
 captureChannelAccount:(...args)=>captureChannelAccount(...args),openChannelSession:(...args)=>openChannelSession(...args),
});
export const {createImSessionRepo,touchUserSent,clearContext,resetSessionToDefaults,switchSessionWorkingDir,readModelRouteSnapshot,updateModelEffort,updatePermissionMode,readPermissionMode}=runtime;
