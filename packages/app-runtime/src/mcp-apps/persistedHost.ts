import {randomUUID} from 'node:crypto';
import {and,eq,isNull,sql} from 'drizzle-orm';
import {messages,sessions} from '@cindy/runtime-db/schema';
import {messageToCamel} from '@cindy/runtime-db/messageMapper';
import type {CurrentDbClientSnapshot} from '@cindy/runtime-db/client/current';
import type {InteractionRequest,InteractionDecision,Logger} from '@cindy/maker-core';
import type {MessagePersistenceHost} from '../messagePersistenceHost.js';
import type {OwnerBroadcastTap} from '../ownerBroadcast.js';
import {parseMcpAppRecord} from '@cindy/maker-shared/mcp-apps';
import type {McpAppsHostDeps} from './host.js';
export function createPersistedMcpAppsHostDeps(options:{
 currentOwner():CurrentDbClientSnapshot|undefined;
 captureDataOwnerBroadcastScope:OwnerBroadcastTap['captureDataOwnerBroadcastScope'];
 createMessage:MessagePersistenceHost['createDbMessage'];
 broadcastMessageRow:MessagePersistenceHost['broadcastMessageRow'];
 getMcpAppRevisionKey():string;
 readAppServer:McpAppsHostDeps['config'];send:McpAppsHostDeps['sendMessage'];
 request(sessionId:string,input:InteractionRequest,signal:AbortSignal):Promise<InteractionDecision>;
 removeMcpAppDocument?:McpAppsHostDeps['disposeDocument'];logger:Pick<Logger,'debug'>;
}):McpAppsHostDeps{
const {currentOwner,captureDataOwnerBroadcastScope,createMessage,broadcastMessageRow,getMcpAppRevisionKey,readAppServer,send,request,removeMcpAppDocument}=options;

  const assertSession = async (sessionId: string) => {
    const owner = currentOwner();
    if (!owner) throw new Error('MCP_APP_OWNER_UNAVAILABLE');
    const [session] = await owner.client.drizzle
      .select()
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    if (currentOwner() !== owner || !session || session.status !== 'active')
      throw new Error('MCP_APP_SESSION_UNAVAILABLE');
    return { owner, session };
  };
return {
    owner: currentOwner,
    config: readAppServer,
    revisionKey: getMcpAppRevisionKey,
    readCard: async (sessionId, clientId) => {
      const { owner } = await assertSession(sessionId);
      const [row] = await owner.client.drizzle
        .select({ content: messages.content, meta: messages.agentMeta })
        .from(messages)
        .where(
          and(
            eq(messages.sessionId, sessionId),
            eq(messages.clientId, clientId),
            eq(messages.role, 'assistant'),
            isNull(messages.rewindAt),
            sql`EXISTS (SELECT 1 FROM sessions WHERE sessions.id = ${sessionId} AND sessions.status = 'active' AND (sessions.cleared_at IS NULL OR ${messages.createdAt} > sessions.cleared_at))`,
          ),
        )
        .limit(1);
      if (currentOwner() !== owner || !row) throw new Error('MCP_APP_CARD_UNAVAILABLE');
      const meta = row.meta ? JSON.parse(row.meta) : null;
      const record = parseMcpAppRecord(row.content ? JSON.parse(row.content) : null);
      if (!record || meta?.mcpApp !== true) throw new Error('MCP_APP_CARD_UNAVAILABLE');
      return record;
    },
    writeCard: async (sessionId, clientId, record) => {
      const { owner, session } = await assertSession(sessionId);
      const scope = captureDataOwnerBroadcastScope();
      const [row] = await owner.client.drizzle
        .select()
        .from(messages)
        .where(and(eq(messages.sessionId, sessionId), eq(messages.clientId, clientId)))
        .limit(1);
      if (currentOwner() !== owner) throw new Error('MCP_APP_OWNER_CHANGED');
      if (row) {
        if (row.rewindAt || (session.clearedAt && row.createdAt <= session.clearedAt))
          throw new Error('MCP_APP_CARD_UNAVAILABLE');
        const existing = parseMcpAppRecord(row.content ? JSON.parse(row.content) : null);
        const meta = row.agentMeta ? JSON.parse(row.agentMeta) : null;
        if (
          row.role !== 'assistant' ||
          meta?.mcpApp !== true ||
          !existing ||
          existing.serverRevision !== record.serverRevision
        )
          throw new Error('MCP_APP_CARD_UNAVAILABLE');
        const updated = await owner.client.drizzle
          .update(messages)
          .set({ content: JSON.stringify({ mcpApp: record }) })
          .where(
            and(
              eq(messages.id, row.id),
              isNull(messages.rewindAt),
              sql`EXISTS (SELECT 1 FROM sessions WHERE sessions.id = ${sessionId} AND sessions.status = 'active' AND (sessions.cleared_at IS NULL OR ${messages.createdAt} > sessions.cleared_at))`,
            ),
          )
          .returning();
        if (currentOwner() !== owner || !updated[0]) throw new Error('MCP_APP_CARD_UNAVAILABLE');
        broadcastMessageRow(sessionId, messageToCamel(updated[0]), scope);
      } else {
        // Only the pending card may be inserted. Completion cannot resurrect a deleted grant.
        if (record.result !== undefined || record.cancelled !== undefined)
          throw new Error('MCP_APP_CARD_UNAVAILABLE');
        await createMessage(
          sessionId,
          { clientId, role: 'assistant', content: { mcpApp: record }, agentMeta: { mcpApp: true } },
          {
            broadcastOwnerScope: scope,
            beforePublish: async () => {
              const latest = await assertSession(sessionId);
              if (latest.owner !== owner || latest.session.clearedAt !== session.clearedAt)
                throw new Error('MCP_APP_CARD_UNAVAILABLE');
            },
          },
        );
      }
    },
    authorizeTool: async (sessionId, tool, args, signal) => {
      const { session } = await assertSession(sessionId);
      if (session.permissionMode === 'bypassPermissions') return;
      const decision = await request(
        sessionId,
        {
          kind: 'permission',
          requestId: randomUUID(),
          toolName: `MCP App: ${tool.name}`,
          title: tool.title ?? tool.name,
          description: tool.description,
          input: args,
        },
        signal,
      );
      if (decision.kind !== 'permission' || decision.behavior !== 'allow')
        throw new Error('MCP_APP_TOOL_DENIED');
    },
    sendMessage: send,
    disposeDocument: removeMcpAppDocument,
    audit: (method) => options.logger.debug('App request', { method }),
  };
}
