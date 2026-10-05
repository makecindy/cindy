import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpProvider } from '@cindy/maker-core';
import { resolveLiziMcpSessionContext } from '@cindy/mcps';
import { listCompanionImportSources, previewCompanionImport, startCompanionImport, getCompanionImportResult } from './host.js';
import { eq } from 'drizzle-orm';
import { getDbClient } from '../localDb/client/current.js';
import { sessions, sharedTaskEvents } from '../localDb/schema.js';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../appSessionState.js';
import { CompanionImportError } from './types.js';
import { companionImportToolArgs } from './importProviderSchema.js';
import type { CompanionImportSelection } from '@cindy/maker-shared/companion-import';

/** Commands and the GUI share the same selection, durable receipt and takeover transaction. */
export function createCompanionImportProvider(): McpProvider {
  return { name: 'companion_import', toClaudeSdkConfig(context) {
    const server = new McpServer({ name: 'companion_import', version: '1.0.0' });
    server.tool('import_agent', 'Import a selected local Hermes/OpenClaw agent into a teammate. Discover sources, preview selectable metadata, then import only IDs explicitly selected by the user. Secrets remain on the host. For takeover, the user must request taking over the automations. Poll status by the same requestId; never invent a new requestId after a lost reply.', companionImportToolArgs, async input => {
      const session = resolveLiziMcpSessionContext(context);
      if (!session.sessionId) return { isError: true, content: [{ type: 'text', text: 'IMPORT_CALLER_UNAVAILABLE' }] };
      const controller = `command:${session.sessionId}`;
      try {
        const owner = activeOwnerScopeKey();
        const db = getDbClient().drizzle;
        const [task] = await db.select({ source: sessions.source, status: sessions.status, remoteHostId: sessions.remoteHostId }).from(sessions).where(eq(sessions.id, session.sessionId)).limit(1);
        const [shared] = await db.select({ id: sharedTaskEvents.id }).from(sharedTaskEvents).where(eq(sharedTaskEvents.sessionId, session.sessionId)).limit(1);
        // Local account migration is an owner operation. Guest/IM/SSH tasks cannot
        // use an ambient desktop login to discover or import this computer's credentials.
        if (!task || !['desktop', 'bot'].includes(task.source ?? '') || task.status !== 'active' || task.remoteHostId || shared || isAppSessionBoundaryPending() || owner !== activeOwnerScopeKey()) throw new CompanionImportError('IMPORT_CALLER_UNAVAILABLE');
        const result = input.operation === 'sources' ? await listCompanionImportSources(controller)
          : input.operation === 'preview' && input.sourceId ? await previewCompanionImport(input.sourceId, controller)
            // Length-2 arrays are re-checked as [first, last] pairs by validateImportSelection.
            : input.operation === 'start' && input.selection ? await startCompanionImport(input.selection as CompanionImportSelection, controller)
              : input.operation === 'status' && input.requestId ? await getCompanionImportResult(input.requestId) : undefined;
        if (result === undefined && input.operation !== 'status') throw new CompanionImportError('INVALID_REQUEST');
        return { content: [{ type: 'text', text: JSON.stringify(result ?? null) }] };
      } catch (error) { return { isError: true, content: [{ type: 'text', text: error instanceof CompanionImportError ? error.code : 'IMPORT_FAILED' }] }; }
    });
    return { type: 'sdk', name: 'companion_import', instance: server };
  } };
}
