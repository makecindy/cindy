/**
 * Recent-session bulk retitling and session-title preference IPC.
 * Only auto-titled desktop sessions are eligible; each write keeps a
 * title + title_source CAS so manual renames always win.
 */

import { ipcMain } from 'electron';
import { and, eq, gte } from 'drizzle-orm';

import { normalizeAutoTitle } from '@cindy/maker-shared/session-title';

import { getDbClient } from '../localDb/client/current.js';
import { notifyAgentIslandSessionPatch } from '../localDb/agentIslandSessionPatch.js';
import { broadcastSessionPatched } from '../localDb/ipc/sessions.js';
import {
  regenerateTitleMaterial,
  type RegenerateTitleMaterial,
} from '../localDb/latestMessageText.js';
import { sessions } from '../localDb/schema.js';
import { createLogger } from '../logger.js';
import {
  readSessionTitleSettings,
  readSessionTitleSettingsState,
  resetSessionTitleSettings,
  writeSessionTitleSettings,
  SESSION_TITLE_LANGUAGES,
  SESSION_TITLE_STYLES,
  type SessionTitleSettings,
} from '../session-title-settings-store.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { throwIpcError } from '../utils/ipcValidate.js';

import { regenerateMakerSessionTitle } from './title.js';
import { MAKER_INVOKE } from './channels.js';

const log = createLogger('maker-ipc/retitle-recent-sessions');

const RETITLE_RECENT_WINDOW = 8;
const RETITLE_CONCURRENCY = 3;

export type RetitleRecentSessionsWindowDays = 7 | 30;

export interface RetitleRecentSessionsResult {
  total: number;
  renamed: number;
  skipped: number;
  failed: number;
}

export interface RetitleRecentSessionCandidate {
  id: string;
  title: string;
}

export interface RetitleRecentSessionsDeps {
  now: () => number;
  readSettings: () => SessionTitleSettings;
  listCandidates: (sinceMs: number) => Promise<RetitleRecentSessionCandidate[]>;
  collectRawMaterial: (sessionId: string) => Promise<RegenerateTitleMaterial>;
  generateTitle: (
    sessionId: string,
    settings: SessionTitleSettings,
  ) => Promise<string | null>;
  writeTitleIfStillAuto: (
    sessionId: string,
    expectedTitle: string,
    nextTitle: string,
  ) => Promise<boolean>;
}

async function listRecentAutoTitleCandidates(
  sinceMs: number,
): Promise<RetitleRecentSessionCandidate[]> {
  return getDbClient()
    .drizzle.select({ id: sessions.id, title: sessions.title })
    .from(sessions)
    .where(
      and(
        eq(sessions.status, 'active'),
        eq(sessions.source, 'desktop'),
        eq(sessions.titleSource, 'auto'),
        gte(sessions.updatedAt, sinceMs),
      ),
    )
    .orderBy(sessions.updatedAt);
}

export async function generateTitleWithSnapshot(
  sessionId: string,
  settings: SessionTitleSettings,
): Promise<string | null> {
  if (settings.style !== 'raw') {
    return regenerateMakerSessionTitle(sessionId, undefined, false, settings);
  }
  const { opening } = await regenerateTitleMaterial(
    sessionId,
    RETITLE_RECENT_WINDOW,
    false,
    { preferHookUserText: true },
  );
  return normalizeAutoTitle(opening.text) || null;
}

export async function writeTitleIfStillAuto(
  sessionId: string,
  expectedTitle: string,
  nextTitle: string,
): Promise<boolean> {
  const result = await getDbClient()
    .drizzle.update(sessions)
    .set({ title: nextTitle, titleSource: 'auto' })
    .where(
      and(
        eq(sessions.id, sessionId),
        eq(sessions.title, expectedTitle),
        eq(sessions.status, 'active'),
        eq(sessions.source, 'desktop'),
        eq(sessions.titleSource, 'auto'),
      ),
    )
    .run();
  if (result.changes !== 1) return false;
  notifyAgentIslandSessionPatch(sessionId, { title: nextTitle });
  broadcastSessionPatched(sessionId, { title: nextTitle });
  return true;
}

const defaultRetitleDeps: RetitleRecentSessionsDeps = {
  now: Date.now,
  readSettings: readSessionTitleSettings,
  listCandidates: listRecentAutoTitleCandidates,
  collectRawMaterial: (sessionId) =>
    regenerateTitleMaterial(sessionId, RETITLE_RECENT_WINDOW, false, {
      preferHookUserText: true,
    }),
  generateTitle: generateTitleWithSnapshot,
  writeTitleIfStillAuto,
};

export async function retitleRecentSessions(
  windowDays: RetitleRecentSessionsWindowDays,
  deps: RetitleRecentSessionsDeps = defaultRetitleDeps,
): Promise<RetitleRecentSessionsResult> {
  const settings = deps.readSettings();
  const candidates = await deps.listCandidates(
    deps.now() - windowDays * 24 * 60 * 60 * 1000,
  );
  const result: RetitleRecentSessionsResult = {
    total: candidates.length,
    renamed: 0,
    skipped: 0,
    failed: 0,
  };

  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(RETITLE_CONCURRENCY, candidates.length) },
    async () => {
      while (nextIndex < candidates.length) {
        const candidate = candidates[nextIndex++];
        try {
          const nextTitle =
            settings.style === 'raw'
              ? normalizeAutoTitle(
                  (await deps.collectRawMaterial(candidate.id)).opening.text,
                ) || null
              : await deps.generateTitle(candidate.id, settings);
          if (!nextTitle) {
            result.skipped++;
            continue;
          }
          const renamed = await deps.writeTitleIfStillAuto(
            candidate.id,
            candidate.title,
            nextTitle,
          );
          if (renamed) result.renamed++;
          else result.skipped++;
        } catch (error) {
          result.failed++;
          log.warn('recent session retitle failed', {
            sessionId: candidate.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    },
  );
  await Promise.all(workers);
  return result;
}

function parseRetitleWindow(raw: unknown): RetitleRecentSessionsWindowDays {
  if (raw !== 7 && raw !== 30) {
    throwIpcError('INVALID_PARAMS', 'windowDays must be 7 or 30');
  }
  return raw;
}

function parseSettingsPatch(raw: unknown): Partial<SessionTitleSettings> {
  if (!raw || typeof raw !== 'object') {
    throwIpcError('INVALID_PARAMS', 'session title settings payload required');
  }
  const patch = raw as { style?: unknown; language?: unknown };
  if (patch.style !== undefined && !SESSION_TITLE_STYLES.includes(patch.style as never)) {
    throwIpcError('INVALID_PARAMS', 'invalid session title style');
  }
  if (
    patch.language !== undefined &&
    !SESSION_TITLE_LANGUAGES.includes(patch.language as never)
  ) {
    throwIpcError('INVALID_PARAMS', 'invalid session title language');
  }
  return patch as Partial<SessionTitleSettings>;
}

export function registerSessionTitleSettingsIpc(): void {
  ipcMain.handle(MAKER_INVOKE.SESSION_TITLE_SETTINGS_GET, (event) => {
    assertTrustedAppRendererEvent(event);
    const state = readSessionTitleSettingsState();
    return { value: state.value, isCustomized: state.isCustomized };
  });

  ipcMain.handle(MAKER_INVOKE.SESSION_TITLE_SETTINGS_SET, (event, payload: unknown) => {
    assertTrustedAppRendererEvent(event);
    return writeSessionTitleSettings(parseSettingsPatch(payload));
  });

  ipcMain.handle(MAKER_INVOKE.SESSION_TITLE_SETTINGS_RESET, (event) => {
    assertTrustedAppRendererEvent(event);
    return resetSessionTitleSettings();
  });

  ipcMain.handle(
    MAKER_INVOKE.RETITLE_RECENT_SESSIONS,
    async (event, windowDays: unknown) => {
      assertTrustedAppRendererEvent(event);
      return retitleRecentSessions(parseRetitleWindow(windowDays));
    },
  );
}
