import type {createConversationSearch} from './conversationSearch.js';
import {and,desc,eq,ne} from 'drizzle-orm';
import type {DbClient} from '@cindy/runtime-db';
import {botProfiles,botSessionLinks,sessions} from '@cindy/runtime-db/schema';
import {parseBotDmThreadRouteKey} from '@cindy/companion-core/botDmThread';
import {requireObject,throwIpcError} from '@cindy/remote-agent/ipcValidate';
import type {createBotProfileService} from './botProfileService.js';
import type {createBotCreationDraft} from './botCreationDraft.js';
import type {createBotMemoryService} from './botMemoryService.js';
import type {createBotSkillService} from './botSkillService.js';
import type {createRowMapper} from './rowMapper.js';
export function registerBotContentHandlers<Event>(host:
 Pick<ReturnType<typeof createBotProfileService>,'captureBotOperationOwner'|'readText'|'getBotRemoteSettingsSource'|'ensureBotDmThreadSession'|'listBotDmThreads'> &
 Pick<ReturnType<typeof createBotCreationDraft>,'generateBotCreationAvatar'|'generateBotCreationDraft'> &
 Pick<ReturnType<typeof createBotSkillService>,'listBotSkillsForBot'> &
 Pick<ReturnType<typeof createRowMapper>,'sessionToCamel'> & ReturnType<typeof createConversationSearch> & {
 getDbClient():DbClient;
 assertTrustedAppRendererEvent(event:Event):void;
 ipcMain:{handle(channel:string,handler:(event:Event,...args:any[])=>unknown):void};
 memory:ReturnType<typeof createBotMemoryService>;
}) {
 const {ipcMain,assertTrustedAppRendererEvent,getDbClient,captureBotOperationOwner,readText,getBotRemoteSettingsSource,ensureBotDmThreadSession,listBotDmThreads,generateBotCreationAvatar,generateBotCreationDraft,listBotSkillsForBot,sessionToCamel,memory,searchConversations}=host;
  /** Bind each memory operation to the account that started it. */
  const withMemoryOwner = async <T>(run: () => Promise<T>): Promise<T> => {
    const owner = captureBotOperationOwner();
    const result = await run();
    owner.assertCurrent();
    return result;
  };
  ipcMain.handle('local-db:bots:generate-avatar', async (event, token: unknown) => {
    assertTrustedAppRendererEvent(event);
    if (typeof token !== 'string') throwIpcError('INVALID_PARAMS', 'Invalid draft');
    try { return await generateBotCreationAvatar(token); }
    catch { throwIpcError('INTERNAL', '头像生成失败，可以继续使用当前头像'); }
  });
  ipcMain.handle('local-db:bots:generate-draft', async (event, raw: unknown) => {
    assertTrustedAppRendererEvent(event);
    const owner = captureBotOperationOwner();
    const profiles = await getDbClient().drizzle.select({ name: botProfiles.displayName }).from(botProfiles).where(ne(botProfiles.status, 'archived'));
    owner.assertCurrent();
    return generateBotCreationDraft(raw, profiles.map(p => p.name));
  });
  // Local settings read; remote clients already use settings:<botId>/skills.
  ipcMain.handle('local-db:bots:skills:list', async (event, rawBotId: unknown) => {
    assertTrustedAppRendererEvent(event);
    const botId = readText(rawBotId, 'botId', 128, true);
    const owner = captureBotOperationOwner();
    await getBotRemoteSettingsSource(botId);
    owner.assertCurrent();
    const skills = await listBotSkillsForBot(botId);
    owner.assertCurrent();
    return skills;
  });
  ipcMain.handle('local-db:bots:memory:list', async (event, rawBotId: unknown, rawQuery: unknown) => {
    assertTrustedAppRendererEvent(event);
    const botId = readText(rawBotId, 'botId', 128, true);
    const query = rawQuery === undefined || rawQuery === null ? '' : readText(rawQuery, 'query', 200);
    return withMemoryOwner(() => memory.list(botId, query));
  });
  ipcMain.handle('local-db:bots:memory:read', async (event, rawBotId: unknown, rawFilename: unknown) => {
    assertTrustedAppRendererEvent(event);
    const botId = readText(rawBotId, 'botId', 128, true);
    return withMemoryOwner(() => memory.read(botId, rawFilename));
  });
  ipcMain.handle('local-db:bots:memory:update', async (event, raw: unknown) => {
    assertTrustedAppRendererEvent(event);
    const body = requireObject(raw);
    const botId = readText(body.botId, 'botId', 128, true);
    if (typeof body.title !== 'string' || typeof body.body !== 'string') {
      throwIpcError('INVALID_PARAMS', 'Invalid memory');
    }
    return withMemoryOwner(() =>
      memory.update({
        botId,
        filename: body.filename as string,
        title: body.title as string,
        body: body.body as string,
        expectedUpdatedAt: body.expectedUpdatedAt as string,
      }),
    );
  });
  ipcMain.handle('local-db:bots:memory:delete', async (event, raw: unknown) => {
    assertTrustedAppRendererEvent(event);
    const body = requireObject(raw);
    const botId = readText(body.botId, 'botId', 128, true);
    await withMemoryOwner(() =>
      memory.delete({
        botId,
        filename: body.filename as string,
        expectedUpdatedAt: body.expectedUpdatedAt as string,
      }),
    );
  });

  // 私聊话题：打开话题时建（或复用）它的隐藏 Session；时间线读本私聊的话题入口。
  ipcMain.handle('local-db:bots:dm-thread:ensure', async (event, raw: unknown) => {
    assertTrustedAppRendererEvent(event);
    const body = requireObject(raw, 'body');
    const botId = readText(body.botId, 'botId', 128, true);
    const rootSessionId = readText(body.rootSessionId, 'rootSessionId', 128, true);
    const rootClientId = readText(body.rootClientId, 'rootClientId', 256, true);
    if (!parseBotDmThreadRouteKey(`dm-thread:${rootSessionId}:${rootClientId}`)) {
      throwIpcError('INVALID_PARAMS', '话题的原消息无效');
    }
    const title = typeof body.title === 'string' ? body.title.trim().slice(0, 120) : '';
    return ensureBotDmThreadSession({ botId, rootSessionId, rootClientId, title: title || '话题' });
  });
  ipcMain.handle('local-db:bots:dm-thread:list', async (event, raw: unknown) => {
    assertTrustedAppRendererEvent(event);
    const body = requireObject(raw, 'body');
    const botId = readText(body.botId, 'botId', 128, true);
    const rootSessionId = readText(body.rootSessionId, 'rootSessionId', 128, true);
    return listBotDmThreads(botId, rootSessionId);
  });

  ipcMain.handle('local-db:bots:history', async (event, rawBotId: unknown) => {
    assertTrustedAppRendererEvent(event);
    const botId = readText(rawBotId, 'botId', 128, true);
    const db = getDbClient().drizzle;
    const links = await db
      .select()
      .from(botSessionLinks)
      .where(and(eq(botSessionLinks.botId, botId), eq(botSessionLinks.role, 'history')))
      .orderBy(desc(botSessionLinks.archivedAt));
    const result = [];
    for (const link of links) {
      const [row] = await db
        .select()
        .from(sessions)
        .where(eq(sessions.id, link.sessionId))
        .limit(1);
      if (!row) continue;
      result.push(
        sessionToCamel({
          ...row,
          messageCount: 0,
          latestMessageContent: null,
          latestMessageRole: null,
        }),
      );
    }
    return result;
  });

  ipcMain.handle('local-db:bots:search-history', async (event, raw: unknown) => {
    assertTrustedAppRendererEvent(event);
    const body =
      raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    const botId = readText(body.botId, 'botId', 128, true);
    const query = readText(body.query, 'query', 500, true);
    const limit =
      typeof body.limit === 'number' && Number.isFinite(body.limit)
        ? Math.max(1, Math.min(50, Math.floor(body.limit)))
        : 20;
    const db = getDbClient().drizzle;
    const [profile] = await db
      .select({ id: botProfiles.id })
      .from(botProfiles)
      .where(eq(botProfiles.id, botId))
      .limit(1);
    if (!profile) throwIpcError('NOT_FOUND', 'Bot 不存在');
    // Group / IM channel lanes only hold hidden channel turns; the group chat or
    // the IM conversation itself is the user's record.
    const links = await db
      .select({ sessionId: botSessionLinks.sessionId })
      .from(botSessionLinks)
      .where(and(
        eq(botSessionLinks.botId, botId),
        ne(botSessionLinks.role, 'group'),
        ne(botSessionLinks.role, 'channel'),
      ));
    return searchConversations(
      {
        query,
        limit,
        semanticMode: 'hybrid',
        filters: {
          status: 'all',
          sessionIds: links.map((row) => row.sessionId),
        },
      },
      // The Bot-owned Session id set above is authoritative. Passing null here
      // allows migrated IM history to retain its original source while keeping
      // the renderer unable to widen the search scope.
      { sessionSources: null },
    );
  });

}
