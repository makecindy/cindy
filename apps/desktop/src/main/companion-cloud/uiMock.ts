/** Optional service fixture for the real Desktop --mock companion route. */
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { and, eq } from 'drizzle-orm';
import { getActiveAppSession, LOCAL_DATA_OWNER_ID, ownerScopedUserDataPath } from '../appSessionState.js';
import { isUiMockDataEnabled } from '../localDb/uiMockSeed.js';
import { getDbClient } from '../localDb/client/current.js';
import { botProfiles, botSessionLinks, sessions } from '../localDb/schema.js';
import { createLogger } from '../logger.js';
import { ensureBotCanonicalSession } from '../maker-ipc/botCanonicalSessionEnsure.js';
import { writeBotProfileFolder } from '../maker-ipc/botProfileFolder.js';
import { createCompanionCloudHost } from './host.js';
import { startCompanionCloud, type CompanionRuntimeActor } from './runtime.js';
import type { CompanionApi } from './types.js';
import type { CompanionRow } from './store.js';
import type { CompanionCloudSnapshot, CompanionProfileRepairRequest } from '../../shared/companionCloud.js';

const BOT_ID = 'ui-mock-profile-recovery';
const SELF = 'ui-mock-desk';
const ACTOR = 'ui-mock-profile-actor';
const PROFILE = 'companion.profile.v1';
let fixture: ReturnType<typeof createFixture> | undefined;

function enabled() {
  return !app.isPackaged && isUiMockDataEnabled() && process.env.XDT_ISOLATED === '1'
    && getActiveAppSession().dataOwnerId === LOCAL_DATA_OWNER_ID;
}

/** Only the Chat Server transport is synthetic; profile validation, backup and restoration are real. */
function createFixture(file: string, soul: string, failHistoryOnce: boolean, currentHome: boolean) {
  const log = createLogger('companion-ui-mock');
  const actors: CompanionRuntimeActor[] = [{ id: ACTOR, kind: 'bot', externalId: BOT_ID, name: '资料恢复验收', homeDeviceId: SELF }];
  const rows = new Map<string, CompanionRow>([[PROFILE, { key: PROFILE, revision: 1,
    value: { name: '资料恢复验收', description: '', soul, user: '', systemPrompt: '' } }]]);
  const api: CompanionApi = async <T>(route: string, method = 'GET', data?: unknown) => {
    if (!enabled()) throw new Error('OWNER_CHANGED');
    const body = data as Record<string, unknown>;
    let result: unknown;
    if (route === '/actors' && method === 'GET') result = actors;
    else if (route === `/actors/${ACTOR}` && method === 'PATCH') {
      if ('expectedHomeDeviceId' in body && body.expectedHomeDeviceId !== actors[0]!.homeDeviceId)
        throw Object.assign(new Error('HOME_DEVICE_CONFLICT'), { status: 409 });
      if ('homeDeviceId' in body) actors[0]!.homeDeviceId = body.homeDeviceId as string;
      result = {};
    } else if (route.startsWith('/preferences') && method === 'GET') result = [...rows.values()];
    else if (route === '/preferences' && method === 'POST') {
      const key = body.key as string;
      const revision = rows.get(key)?.revision ?? 0;
      if (body.expectedRevision !== revision) throw Object.assign(new Error('REVISION_CONFLICT'), { status: 409 });
      const row = { key, revision: revision + 1, value: body.value };
      rows.set(key, row);
      if (key === PROFILE) fs.writeFileSync(file, JSON.stringify(row.value), 'utf8');
      result = row;
    } else if (route === '/conversations') result = { id: '10000000-0000-4000-8000-000000000001' };
    else if (route.includes('/messages?')) {
      if (failHistoryOnce) { failHistoryOnce = false; throw new Error('ECONNRESET'); }
      result = [{ id: 'ui-mock-profile-message', seq: '1', authorId: 'ui-mock-human', origin: 'user',
        createdAt: '2026-11-12T00:00:00.000Z', content: [{ type: 'text', text: '资料更正期间，原有消息仍可查看。' }] }];
    }
    else if (route.endsWith('/messages/import')) result = {};
    else throw new Error('UNKNOWN_MOCK_ROUTE');
    return result as T;
  };
  const host = createCompanionCloudHost({
    deliverToCanonical: async () => ({ ok: true }), listDevices: async () => [], selfDeviceId: () => SELF,
    rebuildContext: async () => 'rebuilt', log,
    ensureCanonicalSession: async botId => {
      // A synthetic existing task, like the ordinary --mock tasks: no model/account connection.
      // The normal canonical reader and the real restore/history writers still run below.
      if (!enabled() || botId !== BOT_ID) throw new Error('OWNER_CHANGED');
      const db = getDbClient().drizzle;
      const [link] = await db.select({ id: botSessionLinks.id }).from(botSessionLinks)
        .where(and(eq(botSessionLinks.botId, botId), eq(botSessionLinks.role, 'canonical'))).limit(1);
      if (!link) {
        if (!enabled()) throw new Error('OWNER_CHANGED');
        const id = '10000000-0000-4000-8000-000000000002';
        const now = Date.now();
        await db.insert(sessions).values({ id, title: '资料恢复验收', source: 'bot', workspaceKind: 'dialogue',
          status: 'active', createdAt: now, updatedAt: now }).onConflictDoNothing();
        if (!enabled()) throw new Error('OWNER_CHANGED');
        await db.insert(botSessionLinks).values({ id: 'ui-mock-profile-link', botId, sessionId: id, role: 'canonical', createdAt: now }).onConflictDoNothing();
        if (!enabled()) throw new Error('OWNER_CHANGED');
        await db.update(botProfiles).set({ canonicalSessionId: id }).where(eq(botProfiles.id, botId));
      }
      const result = await ensureBotCanonicalSession(botId);
      if (!result.ok) throw new Error(result.errorCode);
      return result.sessionId;
    },
  });
  const runtime = startCompanionCloud({ api, host, endpoint: 'https://ui-mock.invalid', humanActorId: 'ui-mock-human',
    selfDeviceId: SELF, current: enabled, actors: () => actors, initialKick: false, log,
    bots: () => runtime.state.isDemoted(BOT_ID) ? [] : [{ botId: BOT_ID, actorId: ACTOR, name: '资料恢复验收' }] });
  runtime.state.update(BOT_ID, ACTOR, entry => { entry.demoted = !currentHome; });
  let prepared: Promise<void> | undefined;
  const prepareCurrentHome = () => prepared ??= (async () => {
    if (!currentHome) return;
    const fence = { assertCurrent() { if (!enabled()) throw new Error('OWNER_CHANGED'); } };
    const local = host.materializer!;
    if (!await local.readProfile(BOT_ID)) {
      await local.createProfile({ id: BOT_ID, name: '资料恢复验收', description: '', identitySource: '', userContextSource: '', avatar: null }, fence);
      await local.ensureCanonicalSession(BOT_ID, fence);
      fence.assertCurrent();
      // Simulate an existing home whose owner edited SOUL.md past the accepted limit.
      await writeBotProfileFolder(ownerScopedUserDataPath(), BOT_ID, { identitySource: soul });
    }
    runtime.reconcile([{ id: BOT_ID, status: 'active' }]);
  })();
  return {
    botId: BOT_ID,
    snapshot: (): CompanionCloudSnapshot => ({ enabled: true, selfDeviceId: SELF, humanActorId: 'ui-mock-human',
      demotedBotIds: runtime.state.isDemoted(BOT_ID) ? [BOT_ID] : [], actors: [{ id: ACTOR, externalId: BOT_ID, name: '资料恢复验收',
        avatar: null, homeDeviceId: SELF, homeDevice: { deviceId: SELF, name: 'Mock desktop', isSelf: true, online: true },
        ...(runtime.state.isDemoted(BOT_ID) || (currentHome && String((rows.get(PROFILE)?.value as { soul?: unknown })?.soul ?? '').trim().length > 12000)
          ? { profileFailure: runtime.profileFailure(BOT_ID) ?? { field: 'identitySource' as const, maxLength: 12000 } } : {}) }] }),
    async takeOver() {
      await prepareCurrentHome();
      const result = await runtime.takeOver(BOT_ID);
      if (result.ok) await runtime.syncNow();
      return result;
    },
    async repairProfile(request: CompanionProfileRepairRequest) {
      await prepareCurrentHome();
      const result = await runtime.repairProfile(BOT_ID, request);
      if (result.ok && request.action === 'save') await runtime.syncNow();
      return result;
    },
    transcript: { messages: [{ id: 'ui-mock-profile-message', seq: '1', role: 'user' as const,
      text: '资料更正期间，原有消息仍可查看。', createdAt: 1 }] },
  };
}

/** Missing fixture is the ordinary mock mode. Only the isolated, local-owner sandbox can opt in. */
export function companionProfileUiMock() {
  if (!enabled()) return undefined;
  if (fixture) return fixture;
  const file = path.join(app.getPath('userData'), 'ui-mock', 'companion-profile.json');
  let source: unknown;
  let failHistoryOnce = false;
  let currentHome = false;
  try {
    const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    source = config.soul;
    failHistoryOnce = config.failHistoryOnce === true;
    currentHome = config.currentHome === true;
  } catch { return undefined; }
  if (typeof source !== 'string') return undefined;
  fixture = createFixture(file, source, failHistoryOnce, currentHome);
  return fixture;
}
