import { ipcMain } from 'electron';
import { and, desc, inArray, ne } from 'drizzle-orm';

import type { AgentKind, Maker, OneShotOptions } from '@cindy/maker-core';
import { BRAND_NAME } from '@cindy/maker-shared/branding';

import { createLogger } from '../logger.js';
import { isAgentOneShotRouteDisabled } from '../maker-host/model-route-guard-live.js';
import { getDbClient } from '../localDb/client/current.js';
import { sessions } from '../localDb/schema.js';
import { isAuxiliaryModelCustomized } from '../utility-model/auxiliary-model-settings-store.js';
import { agentSupportsOneShot, requestUtilityText } from '../utility-model/oneShotCandidates.js';
import { MAKER_INVOKE } from './channels.js';
import { DESKTOP_VISIBLE_SESSION_SOURCES } from '../../shared/sessionSource.js';
import type {
  HelpAnswerResult,
  HelpAskRequest,
  HelpLocale,
  HelpMessage,
  HelpTabId,
} from '../../shared/helpTypes.js';
import { truncateHelpHistory } from '../../shared/helpTypes.js';
import { HELP_KNOWLEDGE, type HelpKnowledgeDoc } from './helpKnowledge.generated.js';

const log = createLogger('maker-ipc/help');

// Settings tabs the assistant may deep-link to. This is the hard whitelist that
// LLM output is validated against (parseAssistantOutput) — the model is never
// trusted to invent tab ids (CLAUDE.md rule 16: deterministic check in code).
const ALLOWED_TABS = new Set<HelpTabId>([
  'general',
  'personalization',
  'api-keys',
  'providers',
  'voice-input',
  'import',
  'connections',
  'im-bot',
  'about',
  'ghosts',
  'remote-control',
]);

// Knowledge routing (progressive disclosure):
// - HELP_INDEX (id/title/summary) is the cheap first level shown to the router.
// - Only the full content of routed docs is loaded into the answer prompt.
const HELP_INDEX = HELP_KNOWLEDGE.map(({ id, title, summary }) => ({ id, title, summary }));
const KNOWN_DOC_IDS: ReadonlySet<string> = new Set(HELP_KNOWLEDGE.map((d) => d.id));
const MAX_ROUTED_DOCS = 2;

// Action-tab menu shown to the answer model, derived from the KB (deduped by
// tab). Independent of ALLOWED_TABS, which stays the authoritative whitelist.
const ACTION_TAB_MENU: ReadonlyArray<{ tab: HelpTabId; purpose: string }> = (() => {
  const byTab = new Map<HelpTabId, string>();
  for (const d of HELP_KNOWLEDGE) {
    if (d.tab && !byTab.has(d.tab)) byTab.set(d.tab, d.summary);
  }
  return [...byTab].map(([tab, purpose]) => ({ tab, purpose }));
})();

const ACTION_TAG_RE = /<action\s+tab="([a-z-]+)"\s*\/?>/i;
// Strip every action tag from the prose (global); only the first is honored.
const ACTION_TAG_STRIP_RE = /<action\s+tab="[a-z-]+"\s*\/?>/gi;

const LOCALE_NAME: Record<HelpLocale, string> = {
  'zh-CN': 'Simplified Chinese',
  'zh-TW': 'Traditional Chinese',
  en: 'English',
  ja: 'Japanese',
  ko: 'Korean',
};

type HelpOneShotTarget = {
  agentKind: AgentKind | null;
  options: OneShotOptions;
};

function normalizeLocale(locale: unknown): HelpLocale {
  return locale === 'zh-CN' || locale === 'zh-TW' || locale === 'en' || locale === 'ja' || locale === 'ko'
    ? locale
    : 'en';
}

function renderTranscript(history: HelpMessage[]): string {
  return history
    .map((m) => `${m.role === 'user' ? 'USER' : 'ASSISTANT'}: ${m.content.trim()}`)
    .join('\n');
}

// ── Stage 1: routing ────────────────────────────────────────────────────────

export function buildRouterPrompt(history: HelpMessage[]): string {
  const topics = HELP_INDEX.map((d) => `- ${d.id}: ${d.title} — ${d.summary}`).join('\n');
  return [
    `You route a product help question to the most relevant help topics for ${BRAND_NAME}.`,
    'Available topics (id: title — summary):',
    topics,
    '',
    'Output the ids of the 1-2 most relevant topics, comma-separated (e.g. "api-keys, integrations").',
    'If none are relevant, output exactly: NONE',
    'Output ids only — no other text.',
    '',
    'Conversation so far:',
    renderTranscript(history),
  ].join('\n');
}

export function parseRouterOutput(raw: string, knownIds: ReadonlySet<string>): string[] {
  const trimmed = raw.trim();
  if (!trimmed || /^none$/i.test(trimmed)) return [];
  const out: string[] = [];
  for (const token of trimmed.split(/[\s,]+/)) {
    const id = token.trim().toLowerCase();
    if (knownIds.has(id) && !out.includes(id)) out.push(id);
    if (out.length >= MAX_ROUTED_DOCS) break;
  }
  return out;
}

async function routeHelpTopics(
  maker: Maker,
  target: HelpOneShotTarget,
  history: HelpMessage[],
): Promise<string[]> {
  if (HELP_KNOWLEDGE.length === 0) return [];
  try {
    const prompt = buildRouterPrompt(history);
    const utility = await requestUtilityText(maker, prompt, {
      maxTokens: 30,
      timeoutMs: 12_000,
    });
    let raw = utility.ok ? utility.text : '';
    // 自动档保留会话 agent 兜底。自定义 1–3 用尽即停，不再打当前任务大模型。
    if (
      !raw &&
      !isAuxiliaryModelCustomized() &&
      target.agentKind &&
      !(await isAgentOneShotRouteDisabled(target.agentKind, target.options.model))
    ) {
      raw = await maker.oneShot(target.agentKind, prompt, {
        ...target.options,
        maxTokens: 30,
        timeoutMs: 12_000,
      });
    }
    return parseRouterOutput(raw, KNOWN_DOC_IDS);
  } catch (err) {
    // Routing is best-effort; on failure fall back to summary-only grounding.
    log.debug('help route failed', { error: String(err) });
    return [];
  }
}

// ── Stage 2: answer ─────────────────────────────────────────────────────────

export function buildHelpPrompt(
  history: HelpMessage[],
  locale: HelpLocale,
  agentKind: AgentKind | null,
  docs: HelpKnowledgeDoc[],
): string {
  // Codex oneShot ignores maxTokens (see codex/index.ts), so cap length in the
  // prompt. Claude already has maxTokens=220 in buildOneShotOptions.
  const lengthHint =
    agentKind === 'codex'
      ? 'Keep your answer under 3 short sentences. Do not use bulleted lists.'
      : '';
  const tabLines = ACTION_TAB_MENU.map((c) => `- ${c.tab} -> ${c.purpose}`).join('\n');
  const hasDocs = docs.length > 0;
  const knowledge = hasDocs
    ? docs.map((d) => `### ${d.title}\n${d.content.trim()}`).join('\n\n')
    : HELP_INDEX.map((d) => `- ${d.title}: ${d.summary}`).join('\n');
  const knowledgeHeader = hasDocs
    ? 'Answer using ONLY the product knowledge below. If it does not cover the question, say you are not sure.'
    : 'Only short topic summaries are available below (no detail). If you are not sure, say so and point to the closest area.';
  return [
    `You are the built-in product help assistant for ${BRAND_NAME} desktop.`,
    'The user is already inside the app — never explain download or login steps unless explicitly asked.',
    '',
    knowledgeHeader,
    'Product knowledge:',
    knowledge,
    '',
    'Settings tabs you may link to (ONLY these ids):',
    tabLines,
    'If your answer involves one of those tabs, end your reply with exactly: <action tab="<id>" />',
    'Do not invent tab ids. Do not emit multiple action tags.',
    '',
    'Rules:',
    `- Reply in ${LOCALE_NAME[locale]}.`,
    '- Keep replies short (a few sentences). Use a bullet list only when truly necessary.',
    '- If the user pushes back on a previous answer, treat the latest user message as authoritative and correct yourself.',
    '- Do not invent features or third-party integrations that are not in the product knowledge above.',
    ...(lengthHint ? [lengthHint] : []),
    '',
    'Conversation so far:',
    renderTranscript(history),
  ].join('\n');
}

/**
 * Extract the optional `<action tab="..." />` tag, strip it from the answer and
 * validate the tab against the whitelist. Unknown tabs drop the action but keep
 * the prose; only the first tag is honored.
 */
export function parseAssistantOutput(raw: string): HelpAnswerResult {
  const trimmed = raw.trim();
  if (!trimmed) return { kind: 'no-answer' };
  const match = trimmed.match(ACTION_TAG_RE);
  const answer = trimmed.replace(ACTION_TAG_STRIP_RE, '').trim();
  if (!answer) return { kind: 'no-answer' };
  if (match && ALLOWED_TABS.has(match[1] as HelpTabId)) {
    return { kind: 'ai', answer, action: { kind: 'settings-tab', tab: match[1] as HelpTabId } };
  }
  return { kind: 'ai', answer };
}

// Request must be a non-empty, well-formed history whose last entry is a user
// message; anything else resolves to no-answer (UI shows the fallback hint).
function isValidHistory(messages: unknown): messages is HelpMessage[] {
  if (!Array.isArray(messages) || messages.length === 0) return false;
  for (const m of messages) {
    if (!m || typeof m !== 'object') return false;
    const { role, content } = m as HelpMessage;
    if (role !== 'user' && role !== 'assistant') return false;
    if (typeof content !== 'string') return false;
  }
  return (messages[messages.length - 1] as HelpMessage).role === 'user';
}

async function getMostRecentSessionAgent(): Promise<AgentKind | null> {
  // 取最近一次活跃 session 的 agentKind 作为优先候选,避免主用 codex 的用户
  // 问 help 时被硬编码的 claude-code 优先级吃配额。DB 异常时返回 null,让
  // pickHelpAgent 回退到静态 priority 即可。
  try {
    const db = getDbClient().drizzle;
    const [row] = await db
      .select({ agentKind: sessions.agentKind })
      .from(sessions)
      .where(
        and(
          inArray(sessions.source, DESKTOP_VISIBLE_SESSION_SOURCES),
          ne(sessions.status, 'deleted'),
        ),
      )
      .orderBy(desc(sessions.updatedAt))
      .limit(1);
    if (!row) return null;
    if (row.agentKind === 'cc' || row.agentKind === 'claude-code') return 'claude-code';
    if (row.agentKind === 'codex') return 'codex';
    if (row.agentKind === 'pi') return 'pi';
    return null;
  } catch (err) {
    log.debug('help recent-agent probe failed', { error: String(err) });
    return null;
  }
}

// help 兜底走 maker.oneShot;只有实现了 oneShot 的 agent(agentSupportsOneShot)才可选。
// PiAgent 继承 BaseAgent 的 not-implemented,选中它会让 HELP_ASK / 置顶摘要抛错并直接
// no-answer,即便其它 agent 兜底仍可用 —— 故从候选里剔除(与任务摘要兜底共用同一判定)。
export async function pickHelpAgent(
  maker: Maker,
  preferredAgent: AgentKind | null,
): Promise<AgentKind | null> {
  const candidates: AgentKind[] = preferredAgent
    ? [...new Set<AgentKind>([preferredAgent, 'claude-code', 'codex', 'pi'])]
    : ['claude-code', 'codex', 'pi'];
  const ordered = candidates.filter((agentKind) => agentSupportsOneShot(agentKind));
  const available = new Set(maker.listAvailableAgents());
  for (const agentKind of ordered) {
    if (!available.has(agentKind)) continue;
    try {
      const auth = await maker.getAgentAuthState(agentKind);
      if (auth.authenticated) return agentKind;
    } catch (err) {
      log.debug('help auth probe failed', { agentKind, error: String(err) });
    }
  }
  return null;
}

function buildOneShotOptions(agentKind: AgentKind): OneShotOptions {
  if (agentKind === 'claude-code') {
    return {
      model: 'claude-haiku-4-5',
      maxTokens: 220,
      timeoutMs: 20_000,
    };
  }
  // Pi 的可用模型来自动态 provider 目录(BYOM 也可能只有本地模型)，不硬编码
  // GPT id；让 Maker 按该 Pi agent 的当前能力选择默认模型。
  if (agentKind === 'pi') return { timeoutMs: 20_000 };
  return {
    model: 'gpt-5.4-mini',
    timeoutMs: 20_000,
  };
}

async function pickHelpOneShotTarget(
  maker: Maker,
  preferredAgent: AgentKind | null,
): Promise<HelpOneShotTarget> {
  const agentKind = await pickHelpAgent(maker, preferredAgent);
  if (!agentKind) {
    return {
      agentKind: null,
      options: {
        timeoutMs: 20_000,
      },
    };
  }
  return {
    agentKind,
    options: buildOneShotOptions(agentKind),
  };
}

export function registerMakerHelpIpc(maker: Maker): void {
  ipcMain.handle(
    MAKER_INVOKE.HELP_ASK,
    async (_event: Electron.IpcMainInvokeEvent, request: unknown): Promise<HelpAnswerResult> => {
      const req = (request ?? {}) as Partial<HelpAskRequest>;
      if (!isValidHistory(req.messages)) return { kind: 'no-answer' };
      const locale = normalizeLocale(req.locale);
      try {
        const preferredAgent = await getMostRecentSessionAgent();
        const target = await pickHelpOneShotTarget(maker, preferredAgent);
        const history = truncateHelpHistory(req.messages);
        // Stage 1: route to relevant KB docs (cheap, index-only).
        const routedIds = await routeHelpTopics(maker, target, history);
        const docs = HELP_KNOWLEDGE.filter((d) => routedIds.includes(d.id));
        // Stage 2: answer grounded in the routed docs (or summaries on miss).
        const prompt = buildHelpPrompt(history, locale, target.agentKind, docs);
        const utility = await requestUtilityText(maker, prompt, {
          ...target.options,
        });
        let raw = utility.ok ? utility.text : '';
        // 自动档保留会话 agent 兜底。自定义 1–3 用尽即停，不再打当前任务大模型。
        if (
          !raw &&
          !isAuxiliaryModelCustomized() &&
          target.agentKind &&
          !(await isAgentOneShotRouteDisabled(target.agentKind, target.options.model))
        ) {
          raw = await maker.oneShot(target.agentKind, prompt, target.options);
        }
        if (utility.ok) {
          log.debug('help ask used utility model', {
            provider: utility.providerId,
            model: utility.model,
            transport: utility.transport,
          });
        }
        return parseAssistantOutput(raw);
      } catch (err) {
        log.warn('help ask failed', { error: String(err) });
        return { kind: 'no-answer' };
      }
    },
  );
}
