/**
 * Expert ↔ session binding (ROADMAP 3.2a).
 *
 * The owner picks an expert on the new-task page; that choice is "pending" (in memory, visible
 * in the picker) until the next fresh Hermes session sends its first turn. At that moment the
 * pending expert is bound to that Cindy session in `~/.cindy-harness/expert-sessions.json`
 * (atomic temp+rename) and its prompt is prepended to the first turn, exactly like the daemon's
 * own first-turn preamble. A bound session keeps its expert for good, so the header can show it
 * after a restart; the expert's prompt itself always comes from its files.
 *
 * Fail closed (AGENTS.md §6.3): a bound expert that no longer loads, is not a Hermes expert, or
 * names a model route the session is not on refuses the send with a message saying what to fix.
 * Nothing here switches the model.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { loadExpert, type Expert } from '@cindy/maker-core/experts';

/** Expert slugs are directory names under the experts root; nothing else is accepted. */
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isValidExpertSlug(slug: unknown): slug is string {
  return typeof slug === 'string' && SLUG.test(slug) && !slug.includes('..');
}

/** A pending pick older than this is ignored, so a forgotten pick never captures a later session. */
export const PENDING_EXPERT_TTL_MS = 30 * 60_000;

export interface ExpertSessionBindingView {
  sessionId: string;
  slug: string;
  dir: string;
  /** Present when the expert loads. */
  name?: string;
  model?: string;
  /** Present when the bound expert no longer loads. */
  error?: string;
}

interface BindingsFile {
  version: 1;
  sessions: Record<string, { slug: string; boundAt: string }>;
}

export interface ExpertSessionStoreOptions {
  /** Directory holding one sub-directory per expert. */
  rootDir: string;
  /** Binding file (production: ~/.cindy-harness/expert-sessions.json). */
  bindingsFile: string;
  now?: () => number;
}

/** Model route check, injected so tests need no providers.yaml. */
export type RouteMatcher = (expertRoute: string, sessionModel: string) =>
  | { ok: true }
  | { ok: false; message: string };

export class ExpertSessionStore {
  private pending: { slug: string; at: number } | null = null;
  private readonly listeners = new Set<(event: ExpertSessionEvent) => void>();
  private readonly now: () => number;

  constructor(private readonly opts: ExpertSessionStoreOptions) {
    this.now = opts.now ?? Date.now;
  }

  onChange(listener: (event: ExpertSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: ExpertSessionEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A broken listener must not break binding.
      }
    }
  }

  getPending(): string | null {
    if (!this.pending) return null;
    if (this.now() - this.pending.at > PENDING_EXPERT_TTL_MS) {
      this.pending = null;
      return null;
    }
    return this.pending.slug;
  }

  setPending(slug: string | null): string | null {
    if (slug !== null && !isValidExpertSlug(slug)) throw new Error(`invalid expert "${String(slug)}"`);
    this.pending = slug === null ? null : { slug, at: this.now() };
    this.emit({ type: 'pending', slug });
    return slug;
  }

  private readFile(): BindingsFile {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.opts.bindingsFile, 'utf8')) as Partial<BindingsFile>;
      if (parsed && typeof parsed.sessions === 'object' && parsed.sessions !== null) {
        return { version: 1, sessions: parsed.sessions };
      }
    } catch {
      // Missing or unreadable file: no bindings.
    }
    return { version: 1, sessions: {} };
  }

  private writeFile(data: BindingsFile): void {
    const dir = path.dirname(this.opts.bindingsFile);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `.${path.basename(this.opts.bindingsFile)}.${process.pid}.${this.now()}.tmp`);
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.opts.bindingsFile);
  }

  getBoundSlug(sessionId: string): string | null {
    const slug = this.readFile().sessions[sessionId]?.slug;
    return isValidExpertSlug(slug) ? slug : null;
  }

  private bind(sessionId: string, slug: string): void {
    const data = this.readFile();
    data.sessions[sessionId] = { slug, boundAt: new Date(this.now()).toISOString() };
    this.writeFile(data);
    this.emit({ type: 'bound', sessionId, slug });
  }

  describeBinding(sessionId: string): ExpertSessionBindingView | null {
    const slug = this.getBoundSlug(sessionId);
    if (!slug) return null;
    const dir = path.join(this.opts.rootDir, slug);
    const entry = loadExpert(dir);
    return {
      sessionId,
      slug,
      dir,
      ...(entry.expert ? { name: entry.expert.name } : {}),
      ...(entry.expert?.model ? { model: entry.expert.model } : {}),
      ...(entry.error ? { error: entry.error } : {}),
    };
  }

  /**
   * The first-turn preamble for a fresh Hermes session, or null when the session has no expert.
   * Binds a pending pick to this session first. Throws (fails closed) when a bound expert cannot
   * be applied as written.
   */
  resolveFirstTurnPreamble(
    input: { sessionId: string; model: string },
    matchRoute: RouteMatcher,
  ): string | null {
    let slug = this.getBoundSlug(input.sessionId);
    if (!slug) {
      const pending = this.getPending();
      if (!pending) return null;
      this.pending = null;
      this.bind(input.sessionId, pending);
      this.emit({ type: 'pending', slug: null });
      slug = pending;
    }
    const dir = path.join(this.opts.rootDir, slug);
    const entry = loadExpert(dir);
    if (!entry.expert) {
      throw new Error(`Expert "${slug}" cannot be loaded: ${entry.error ?? 'unknown error'}. Fix ${path.join(dir, 'expert.md')} and send again.`);
    }
    const expert = entry.expert;
    if (expert.agent !== 'hermes') {
      throw new Error(`Expert "${expert.name}" is set to agent "${expert.agent}". Only Hermes experts can be started yet (ROADMAP 3.2a).`);
    }
    if (expert.model) {
      const match = matchRoute(expert.model, input.model);
      if (!match.ok) throw new Error(`Expert "${expert.name}": ${match.message}`);
    }
    return buildExpertPreamble(expert);
  }
}

export type ExpertSessionEvent =
  | { type: 'pending'; slug: string | null }
  | { type: 'bound'; sessionId: string; slug: string };

/** The text Hermes receives ahead of the first message. New prompt text for a new feature. */
export function buildExpertPreamble(expert: Pick<Expert, 'name' | 'prompt'>): string {
  return [
    `[Cindy expert: ${expert.name}]`,
    'For this whole session, act as the expert described below.',
    '',
    expert.prompt.trim(),
    '',
    '[End of expert instructions. The owner\'s first message follows.]',
  ].join('\n');
}

/**
 * Production route check: the expert's `model` (a routing.yaml route name, or a model id) and the
 * session model must resolve to the same model on the same endpoint. No switching: on a mismatch
 * the owner picks the model shown in the message.
 */
export function createRouteMatcher(
  resolve: (model: string) => { model: string; baseUrl: string; providerId?: string } | null,
): RouteMatcher {
  return (expertRoute, sessionModel) => {
    const want = resolve(expertRoute);
    if (!want) {
      return {
        ok: false,
        message: `model route "${expertRoute}" is not in ~/.cindy-harness/routing.yaml or providers.yaml. Add the route, or remove "model:" from expert.md.`,
      };
    }
    const have = resolve(sessionModel);
    if (have && have.model === want.model && have.baseUrl === want.baseUrl) return { ok: true };
    const where = want.providerId ? `${want.providerId}/${want.model}` : want.model;
    return {
      ok: false,
      message: `this expert runs on route "${expertRoute}" (${where}), but the session is on "${sessionModel}". Pick ${want.model} in the model menu and send again.`,
    };
  };
}

let desktopStore: ExpertSessionStore | undefined;

/** The one store the IPC handlers and the Hermes first-turn hook share (~/.cindy-harness). */
export function getDesktopExpertSessionStore(): ExpertSessionStore {
  desktopStore ??= new ExpertSessionStore({
    rootDir: path.join(os.homedir(), '.cindy-harness', 'experts'),
    bindingsFile: path.join(os.homedir(), '.cindy-harness', 'expert-sessions.json'),
  });
  return desktopStore;
}
