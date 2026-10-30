import { isDefaultDraftSessionTitle } from '@cindy/maker-shared/session-title';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { recentWorkdirsStore } from '@/lib/recentWorkdirsStore';
import { sessionsStore } from '@/lib/sessionsStore';
import { normalizeWorkingDirForGrouping } from '../../../shared/workingDir';
import { normalizeBotWelcomeContext, type BotWelcomeContext } from '../../../shared/botWelcomeContext';

/** Read already-loaded local metadata only: no ensure(), IPC, history, or model calls. */
export function readCachedBotWelcomeContext(now = Date.now()): BotWelcomeContext | undefined {
  const owner = getDataOwnerGeneration();
  const cutoff = now - 30 * 24 * 60 * 60 * 1000;
  const recent = (raw: string | null | undefined) => {
    const at = raw ? Date.parse(raw) : NaN;
    return Number.isFinite(at) && at >= cutoff && at <= now;
  };
  const projectName = (raw: string | null) => normalizeWorkingDirForGrouping(raw)?.split('/').pop() ?? '';
  try {
    const projects = (recentWorkdirsStore.get() ?? [])
      .filter(row => row.exists && recent(row.lastUsedAt))
      .slice().sort((a, b) => Date.parse(b.lastUsedAt) - Date.parse(a.lastUsedAt))
      .map(row => projectName(row.path));
    const rows = new Map([
      ...(sessionsStore.getByFilter('all') ?? []),
      ...(sessionsStore.getByFilter('archived') ?? []),
      ...(sessionsStore.getByFilter('active') ?? []),
    ].map(row => [row.id, row]));
    const sessions = [...rows.values()].filter(row =>
      row.status !== 'deleted' && row.source !== 'bot' && !row.parentSessionId && row.orcaRole !== 'worker'
      && !row.remoteHostId && !row.deviceLinkDeviceId && recent(row.userSendAt)
      && row.title.trim() && !isDefaultDraftSessionTitle(row.title),
    ).sort((a, b) => Date.parse(b.userSendAt!) - Date.parse(a.userSendAt!));
    const context = normalizeBotWelcomeContext({
      projects: [...new Set([...projects, ...sessions.filter(row => row.workspaceKind === 'project').map(row => projectName(row.workingDir))])],
      tasks: [...new Set(sessions.filter(row => row.source !== 'scheduler').map(row => row.title))],
      automations: [...new Set(sessions.filter(row => row.source === 'scheduler').map(row => row.title))],
    });
    return isDataOwnerGenerationCurrent(owner) ? context : undefined;
  } catch {
    // Optional personalization must not prevent creation if a cache is unavailable.
    return undefined;
  }
}
