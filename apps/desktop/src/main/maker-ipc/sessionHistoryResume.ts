import type { Maker, Session } from '@cindy/maker-core';
import { permissionModeOrAsk } from '@cindy/maker-shared/permission-mode';
import type { sessions } from '../localDb/schema.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import type { MakerSessionCreateOpts } from './sessionRequest.js';

type HistorySettings = Pick<typeof sessions.$inferSelect,
  'status' | 'providerId' | 'effort' | 'fastMode' | 'permissionMode' |
  'planModeEnabled' | 'codexHistoryHasProductPrompt' | 'remoteHostId' | 'orcaRole'>;

/** Reuse the normal host bootstrap for history operations, without user input. */
export async function getOrResumeHistorySession(
  sessionId: string,
  operation: 'pi-tree' | 'rewind',
  deps: {
    maker: Pick<Maker, 'getSession' | 'getSessionMeta'>;
    assertOwner(): void;
    readSettings(): Promise<HistorySettings | null>;
    prepare(options: MakerSessionCreateOpts): Promise<boolean>;
    bootstrap(options: MakerSessionCreateOpts, assertOwner: () => void): Promise<Session>;
  },
): Promise<Session | null> {
  const live = deps.maker.getSession(sessionId);
  if (live) return live;
  const meta = await deps.maker.getSessionMeta(sessionId);
  deps.assertOwner();
  if (!meta || (operation === 'pi-tree' && meta.agentKind !== 'pi')) return null;
  const agentKind = meta.agentKind;
  const requireExistingSession = operation === 'rewind';
  const row = await deps.readSettings();
  deps.assertOwner();
  // Viewing history must never reactivate an archived or deleted task.
  if (!row || row.status !== 'active') return null;
  if (requireExistingSession && (!meta.sdkSessionId || meta.sdkSessionId === '<pending>')) {
    throwIpcError('REWIND_UNSUPPORTED_HISTORY', `${agentKind} history is unavailable for rewind`);
  }
  const options: MakerSessionCreateOpts = {
    id: sessionId,
    agentKind,
    workingDir: meta.workDir,
    model: meta.model,
    // null means the persisted default route; undefined permits inference.
    providerId: row.providerId,
    resumeSessionId: meta.sdkSessionId,
    effort: row.effort as MakerSessionCreateOpts['effort'],
    fastMode: !!row.fastMode,
    permissionMode: permissionModeOrAsk(row.permissionMode),
    ...(agentKind !== 'pi' ? { planMode: !!row.planModeEnabled } : {}),
    ...(agentKind === 'codex' ? {
      codexHistoryHasProductPrompt: row.codexHistoryHasProductPrompt ?? undefined,
    } : {}),
    title: meta.title,
    remoteHostId: row.remoteHostId ?? undefined,
    orcaRole: row.orcaRole as MakerSessionCreateOpts['orcaRole'],
  };
  if (!await deps.prepare(options)) return null;
  deps.assertOwner();
  if (requireExistingSession) {
    // A missing native source cannot be replaced by an empty thread during rewind.
    options.vendorOptions = { ...options.vendorOptions, requireExistingSession: true };
  }
  const resumed = await deps.bootstrap(options, deps.assertOwner);
  deps.assertOwner();
  if (requireExistingSession && resumed.sdkSessionId !== meta.sdkSessionId) {
    throwIpcError('REWIND_UNSUPPORTED_HISTORY', `${agentKind} history changed while resuming for rewind`);
  }
  return resumed;
}
