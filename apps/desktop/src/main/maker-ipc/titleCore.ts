import { eq } from 'drizzle-orm';
import type { AgentKind } from '@cindy/maker-core';
import { AUTO_TITLE_MAX_CHARS } from '@cindy/maker-shared/session-title';
import { dbToMakerAgentKind } from '../../shared/agentKindConversion.js';
import type { SupportedLocale } from '../../shared/locale.js';
import { isIpcError } from '../../shared/ipc-errors.js';
import { getDbClient } from '../localDb/client/current.js';
import { sessions } from '../localDb/schema.js';
import type { RegenerateTitleMaterial } from '../localDb/latestMessageText.js';
import type { TitleOneShotResult } from '../maker-host/title-one-shot.js';
import { validateTitleOutput } from '../maker-host/title-output-validation.js';
import { createLogger } from '../logger.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { buildRegenerateTitlePrompt } from './title-prompt.js';
import type { SessionAutoTitleRequest } from './sessionAutoTitleCore.js';

const log = createLogger('maker-ipc/title');

export const AUTO_TITLE_MESSAGE_SLICE = 200;
export const REGENERATE_RECENT_WINDOW = 8;
export const REGENERATE_OPENING_SLICE = 300;
export const REGENERATE_USER_SLICE = 300;
export const REGENERATE_ASSISTANT_SLICE = 400;

const AUTO_TITLE_TEXT_MAX = 2000;
const SESSION_ID_MAX = 128;
export const TITLE_AGENT_KINDS = ['claude-code', 'codex', 'pi'] as const satisfies readonly AgentKind[];

export interface GenerateTitleRequest {
  message: string;
  agentKind: AgentKind | null;
  sessionId?: string;
}

export interface RegenerateTitleRequest {
  sessionId: string;
}

export interface RegenerateTitleDeps {
  readSessionAgentKind: (sessionId: string) => Promise<AgentKind | 'plugin-engine' | null>;
  collectMaterial: (
    sessionId: string,
    recentLimit: number,
    latestTurnIsInFlight: boolean | (() => boolean),
  ) => Promise<RegenerateTitleMaterial>;
  generateTitle: (
    sessionId: string,
    agentKind: AgentKind | null,
    prompt: string,
  ) => Promise<TitleOneShotResult>;
}

function parseSessionId(raw: unknown, optional = false): string | undefined {
  if (optional && raw === undefined) return undefined;
  if (typeof raw !== 'string' || !raw || raw.length > SESSION_ID_MAX) {
    throwIpcError('INVALID_PARAMS', 'invalid sessionId');
  }
  return raw;
}

function parseAgentKind(raw: unknown): AgentKind | null {
  if (raw === 'acp') return null;
  if (!TITLE_AGENT_KINDS.includes(raw as AgentKind)) {
    throwIpcError('INVALID_PARAMS', 'invalid agentKind');
  }
  return raw as AgentKind;
}

export function parseGenerateTitleRequest(raw: unknown): GenerateTitleRequest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throwIpcError('INVALID_PARAMS', 'generate-title request required');
  }
  const { message, agentKind, sessionId } = raw as Record<string, unknown>;
  if (typeof message !== 'string') {
    throwIpcError('INVALID_PARAMS', 'invalid message');
  }
  const parsedSessionId = parseSessionId(sessionId, true);
  return {
    message: message.slice(0, AUTO_TITLE_TEXT_MAX),
    agentKind: parseAgentKind(agentKind),
    ...(parsedSessionId === undefined ? {} : { sessionId: parsedSessionId }),
  };
}

export function parseRegenerateTitleRequest(raw: unknown): RegenerateTitleRequest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throwIpcError('INVALID_PARAMS', 'regenerate-title request required');
  }
  return { sessionId: parseSessionId((raw as Record<string, unknown>).sessionId)! };
}

export function parseAutoTitleRequest(raw: unknown): SessionAutoTitleRequest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throwIpcError('INVALID_PARAMS', 'auto-title request required');
  }
  const { sessionId, text, agentKind, isUserText } = raw as Record<string, unknown>;
  if (typeof text !== 'string') {
    throwIpcError('INVALID_PARAMS', 'invalid text');
  }
  if (isUserText !== undefined && typeof isUserText !== 'boolean') {
    throwIpcError('INVALID_PARAMS', 'invalid isUserText');
  }
  return {
    sessionId: parseSessionId(sessionId)!,
    text: (text as string).slice(0, AUTO_TITLE_TEXT_MAX),
    agentKind: parseAgentKind(agentKind),
    ...(isUserText === undefined ? {} : { isUserText }),
  };
}

export async function readSessionAgentKindFromDb(sessionId: string): Promise<AgentKind | 'plugin-engine' | null> {
  const [row] = await getDbClient()
    .drizzle.select({ agentKind: sessions.agentKind, status: sessions.status })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  if (!row || row.status === 'deleted') return null;
  if (row.agentKind === 'acp') return 'plugin-engine';
  return dbToMakerAgentKind(row.agentKind);
}

export async function regenerateMakerSessionTitleCore(
  sessionId: string,
  deps: RegenerateTitleDeps,
  latestTurnIsInFlight: boolean | (() => boolean),
  resolveLocale: () => SupportedLocale,
): Promise<string> {
  if (!sessionId) throwIpcError('INVALID_PARAMS', 'sessionId is required');
  try {
    const { recent, opening } = await deps.collectMaterial(
      sessionId,
      REGENERATE_RECENT_WINDOW,
      latestTurnIsInFlight,
    );
    const agentKind = await deps.readSessionAgentKind(sessionId);
    if (!agentKind) {
      log.info('regenerate session title skipped', {
        sessionId,
        reason: 'session-not-found',
      });
      throwIpcError('NOT_FOUND', 'Session not found');
    }
    if (recent.length === 0) {
      log.info('regenerate session title skipped', {
        sessionId,
        reason: 'no-material',
      });
      throwIpcError('TITLE_NO_MATERIAL', 'No text messages are available for AI naming');
    }
    const openingInWindow = opening.rowid != null && recent.some((m) => m.rowid === opening.rowid);
    const openingText =
      !openingInWindow && opening.text ? opening.text.slice(0, REGENERATE_OPENING_SLICE) : null;
    const transcript = recent
      .map((m) =>
        m.role === 'user'
          ? `User: ${m.text.slice(0, REGENERATE_USER_SLICE)}`
          : `Assistant: ${m.text.slice(0, REGENERATE_ASSISTANT_SLICE)}`,
      )
      .join('\n');
    const generated = await deps.generateTitle(
      sessionId,
      agentKind === 'plugin-engine' ? null : agentKind,
      buildRegenerateTitlePrompt(openingText, transcript, resolveLocale()),
    );
    if (generated.status !== 'ok') {
      const context = { sessionId, agentKind, reason: generated.status };
      if (generated.status === 'unsupported-provider') {
        log.info('regenerate session title skipped', context);
        throwIpcError(
          'TITLE_PROVIDER_UNSUPPORTED',
          'The current provider does not support AI naming',
        );
      }
      log.warn('regenerate session title generation failed', context);
      throwIpcError('INTERNAL', 'AI title generation failed');
    }
    const title = validateTitleOutput(generated.title, AUTO_TITLE_MAX_CHARS);
    if (!title) {
      log.warn('regenerate session title rejected model output', {
        sessionId,
        agentKind,
        reason: 'invalid-output',
      });
      throwIpcError('INTERNAL', 'AI title generation failed');
    }
    return title;
  } catch (err) {
    if (isIpcError(err)) throw err;
    log.warn('regenerate session title failed', {
      sessionId,
      error: String(err),
    });
    throwIpcError('INTERNAL', 'AI title generation failed');
  }
}
