import { ipcMain } from 'electron';
import { assertTrustedAppRendererEvent } from '../../security/trustedAppRenderer.js';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../../appSessionState.js';
import { throwIpcError } from '../../utils/ipcValidate.js';
import {
  deleteBotSkillForBot,
  listBotSkillsForBot,
  readBotSkillForBot,
  readBotSkillSourceForBot,
  saveBotSkillForSession,
  saveBotSkillSourceForBot,
  setBotSkillEnabledForBot,
} from '../../maker-ipc/botSkillService.js';
import { BotSkillStoreError, patchCustomBotSkillSource } from '../../maker-ipc/botSkillStore.js';
import { requestBotRuntimeEpochRefresh } from '../../maker-ipc/botRuntimeEpochRefreshSignal.js';
import { buildTeammateGuide, TEAMMATE_GUIDE_DESCRIPTION, TEAMMATE_GUIDE_NAME } from '../../maker-ipc/teammateGuide.js';
import { getBotRemoteResourceSource, getBotRemoteSettingsSource } from './bots';
import type { BotCoreSkill, BotSkillDetail, BotSkillSaveInput } from '../../../shared/botSkill.js';

/**
 * The capability page's Skill actions (cindy-bots-runtime.md §6「伙伴技能分层」): read the shared core, and view,
 * edit, turn off or delete a learned Skill. Local IPC and the remote settings host share these
 * functions so a change on any computer refreshes the teammate at its next safe turn boundary.
 */

function captureOwner() {
  const scopeKey = activeOwnerScopeKey();
  const assertCurrent = () => {
    if (isAppSessionBoundaryPending() || activeOwnerScopeKey() !== scopeKey) {
      throwIpcError('PRECONDITION_FAILED', '账号已切换，请在当前账号重试');
    }
  };
  assertCurrent();
  return { assertCurrent };
}

/** Another computer only reaches teammates it can see; this computer's own page also opens hidden ones. */
export interface BotSkillSettingsScope { remote?: boolean }

async function canonicalSessionOf(botId: string, scope: BotSkillSettingsScope): Promise<string | null> {
  const source = scope.remote ? (await getBotRemoteSettingsSource(botId)).source : await getBotRemoteResourceSource(botId);
  return source.canonicalSessionId ?? null;
}

/** The shared core file every teammate on this computer mounts (it does not state per-teammate switches). */
export function readBotCoreSkill(): BotCoreSkill {
  return { name: TEAMMATE_GUIDE_NAME, description: TEAMMATE_GUIDE_DESCRIPTION, body: buildTeammateGuide({ shared: true }) };
}

export async function readBotSkillForSettings(botId: string, slug: string, scope: BotSkillSettingsScope = {}): Promise<BotSkillDetail | null> {
  const owner = captureOwner();
  await canonicalSessionOf(botId, scope);
  const [detail, list] = await Promise.all([readBotSkillForBot(botId, slug), listBotSkillsForBot(botId)]);
  owner.assertCurrent();
  if (!detail) return null;
  return { ...detail, enabled: list.find((item) => item.slug === slug)?.enabled !== false };
}

export async function saveBotSkillForSettings(botId: string, input: BotSkillSaveInput, scope: BotSkillSettingsScope = {}): Promise<void> {
  const owner = captureOwner();
  const canonical = await canonicalSessionOf(botId, scope);
  const source = await readBotSkillSourceForBot(botId, input.slug);
  owner.assertCurrent();
  if (!canonical) throwIpcError('PRECONDITION_FAILED', 'Teammate unavailable');
  // An imported skill keeps its own frontmatter (allowed-tools and the like); name, description and body change.
  let patched: string | null = null;
  try { patched = source === null ? null : patchCustomBotSkillSource(source, { ...input, updatedAt: new Date().toISOString() }); }
  catch (error) { throwIpcError('PRECONDITION_FAILED', error instanceof BotSkillStoreError ? error.message : 'Skill could not be saved'); }
  if (patched !== null) {
    try { await saveBotSkillSourceForBot(botId, input.slug, patched, { expectedUpdatedAt: input.expectedUpdatedAt }); }
    catch (error) {
      if (error instanceof BotSkillStoreError) throwIpcError('PRECONDITION_FAILED', 'Skill could not be saved; refresh before retrying');
      throw error;
    }
    owner.assertCurrent();
    await requestBotRuntimeEpochRefresh(canonical, 'resource');
    return;
  }
  const result = await saveBotSkillForSession({ callerSessionId: canonical, ...input });
  owner.assertCurrent();
  if (!result.ok) throwIpcError('PRECONDITION_FAILED', 'Skill could not be saved; refresh before retrying');
}

/** Off keeps the files but stops mounting the Skill (the folder moves to disabled-skills/). */
export async function setBotSkillEnabledForSettings(botId: string, slug: string, enabled: boolean, scope: BotSkillSettingsScope = {}): Promise<void> {
  const owner = captureOwner();
  const canonical = await canonicalSessionOf(botId, scope);
  owner.assertCurrent();
  try { await setBotSkillEnabledForBot(botId, slug, enabled); }
  catch (error) {
    if (error instanceof BotSkillStoreError && error.errorCode === 'NOT_FOUND') throwIpcError('NOT_FOUND', 'Skill does not exist');
    throw error;
  }
  owner.assertCurrent();
  if (canonical) await requestBotRuntimeEpochRefresh(canonical, 'resource');
}

export async function deleteBotSkillForSettings(botId: string, slug: string, scope: BotSkillSettingsScope = {}): Promise<void> {
  const owner = captureOwner();
  const canonical = await canonicalSessionOf(botId, scope);
  owner.assertCurrent();
  await deleteBotSkillForBot(botId, slug);
  owner.assertCurrent();
  if (canonical) await requestBotRuntimeEpochRefresh(canonical, 'resource');
}

const text = (value: unknown, field: string, max: number): string => {
  if (typeof value !== 'string' || !value.trim()) throwIpcError('INVALID_PARAMS', `${field} 不能为空`);
  if (value.length > max) throwIpcError('INVALID_PARAMS', `${field} 超过长度上限 ${max}`);
  return value.trim();
};

function readSaveInput(raw: unknown): BotSkillSaveInput {
  if (!raw || typeof raw !== 'object') throwIpcError('INVALID_PARAMS', 'Skill required');
  const input = raw as Record<string, unknown>;
  return {
    slug: text(input.slug, 'slug', 128),
    name: text(input.name, 'name', 64),
    description: text(input.description, 'description', 280),
    // Body keeps its own whitespace; the store also validates its 64 KB cap.
    body: typeof input.body === 'string' && input.body.trim() && input.body.length <= 64 * 1024
      ? input.body : throwIpcError('INVALID_PARAMS', 'body 不能为空且不超过 64 KB'),
    ...(typeof input.expectedUpdatedAt === 'string' ? { expectedUpdatedAt: input.expectedUpdatedAt } : {}),
  };
}

export function registerBotSkillSettingsIpc(): void {
  ipcMain.handle('local-db:bots:skills:core', (event) => {
    assertTrustedAppRendererEvent(event);
    return readBotCoreSkill();
  });
  ipcMain.handle('local-db:bots:skills:read', async (event, rawBotId: unknown, rawSlug: unknown) => {
    assertTrustedAppRendererEvent(event);
    return readBotSkillForSettings(text(rawBotId, 'botId', 128), text(rawSlug, 'slug', 128));
  });
  ipcMain.handle('local-db:bots:skills:save', async (event, rawBotId: unknown, raw: unknown) => {
    assertTrustedAppRendererEvent(event);
    await saveBotSkillForSettings(text(rawBotId, 'botId', 128), readSaveInput(raw));
  });
  ipcMain.handle('local-db:bots:skills:set-enabled', async (event, rawBotId: unknown, rawSlug: unknown, rawEnabled: unknown) => {
    assertTrustedAppRendererEvent(event);
    if (typeof rawEnabled !== 'boolean') throwIpcError('INVALID_PARAMS', 'enabled 必须是布尔值');
    await setBotSkillEnabledForSettings(text(rawBotId, 'botId', 128), text(rawSlug, 'slug', 128), rawEnabled);
  });
  ipcMain.handle('local-db:bots:skills:delete', async (event, rawBotId: unknown, rawSlug: unknown) => {
    assertTrustedAppRendererEvent(event);
    await deleteBotSkillForSettings(text(rawBotId, 'botId', 128), text(rawSlug, 'slug', 128));
  });
}
