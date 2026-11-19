/**
 * Task engines ("harnesses") a plugin provides to Cindy.
 *
 * The manifest declares each engine (`harnesses`, schemaVersion 3 only): a name, a protocol and a
 * packaged Node entry from `node.entries`. Cindy starts that entry itself and speaks the protocol
 * over its stdio; the plugin never supplies a command. Whether the engine can run right now (for
 * example, whether an external CLI is installed) is published at runtime through `PUT /harnesses`,
 * so the model picker reads stored metadata and never waits on the plugin.
 */

/** Protocols this Host can run. Other values stay in the declaration as data and never start. */
export const GHOST_HARNESS_PROTOCOLS = ['acp'] as const;
export type GhostHarnessProtocol = (typeof GHOST_HARNESS_PROTOCOLS)[number];

export const GHOST_HARNESSES_MAX = 4;
export const GHOST_HARNESS_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;
const NAME_MAX = 64;
const DESCRIPTION_MAX = 200;
const PROTOCOL_RE = /^[a-z][a-z0-9._/-]{0,63}$/;
const LOCALES_MAX = 16;
const LOCALE_RE = /^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{1,8}){0,3}$/;
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export interface GhostHarnessText {
  name?: string;
  description?: string;
}

export interface GhostHarnessDecl {
  id: string;
  name: string;
  description?: string;
  /** Only `acp` runs today; any other well-formed value is kept but inactive. */
  protocol: string;
  /** Exactly one of `node.entries` (never the main `node.entry`). */
  entry: string;
  locales?: Record<string, GhostHarnessText>;
  /** Future per-engine fields are preserved as data and never interpreted. */
  [key: string]: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isText = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max;

function parseText(raw: unknown): GhostHarnessText | null {
  if (!isRecord(raw)) return null;
  if (raw.name !== undefined && !isText(raw.name, NAME_MAX)) return null;
  if (raw.description !== undefined && !isText(raw.description, DESCRIPTION_MAX)) return null;
  return {
    ...(raw.name !== undefined ? { name: raw.name as string } : {}),
    ...(raw.description !== undefined ? { description: raw.description as string } : {}),
  };
}

export type GhostHarnessesParse =
  | { ok: true; harnesses: GhostHarnessDecl[] }
  | { ok: false; reason: string };

/**
 * Validate the manifest declaration. `node` is the already validated `node` section; a harness
 * entry must name one of its extra `entries` exactly, because Cindy starts it in raw stdio mode,
 * while the main entry speaks the plugin host protocol.
 */
export function parseGhostHarnesses(
  raw: unknown,
  node: { entry: string; entries?: readonly string[] } | undefined,
): GhostHarnessesParse {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > GHOST_HARNESSES_MAX) {
    return { ok: false, reason: `harnesses must be an array of 1–${GHOST_HARNESSES_MAX} engines` };
  }
  if (!node) return { ok: false, reason: 'harnesses requires a node worker declaration' };
  const entries = node.entries ?? [];
  const harnesses: GhostHarnessDecl[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!isRecord(item) || typeof item.id !== 'string' || !GHOST_HARNESS_ID_RE.test(item.id)) {
      return { ok: false, reason: 'harnesses[].id must be 1–32 lowercase letters, digits or dashes, starting with a letter' };
    }
    const { id } = item;
    if (seen.has(id)) return { ok: false, reason: `Duplicate harness id ${id}` };
    seen.add(id);
    if (!isText(item.name, NAME_MAX)) return { ok: false, reason: `Harness ${id} needs a name of 1–${NAME_MAX} characters` };
    if (item.description !== undefined && !isText(item.description, DESCRIPTION_MAX)) {
      return { ok: false, reason: `Harness ${id} has a description over ${DESCRIPTION_MAX} characters` };
    }
    if (typeof item.protocol !== 'string' || !PROTOCOL_RE.test(item.protocol)) {
      return { ok: false, reason: `Harness ${id} needs a protocol such as "acp"` };
    }
    if (typeof item.entry !== 'string' || !entries.includes(item.entry)) {
      return { ok: false, reason: `Harness ${id} entry must exactly match one of node.entries` };
    }
    let locales: Record<string, GhostHarnessText> | undefined;
    if (item.locales !== undefined) {
      if (!isRecord(item.locales) || Object.keys(item.locales).length > LOCALES_MAX) {
        return { ok: false, reason: `Harness ${id} has invalid locales` };
      }
      locales = {};
      for (const [locale, value] of Object.entries(item.locales)) {
        const text = LOCALE_RE.test(locale) && !RESERVED_KEYS.has(locale) ? parseText(value) : null;
        if (!text) return { ok: false, reason: `Harness ${id} has invalid text for locale ${locale}` };
        locales[locale] = text;
      }
    }
    const extensions = Object.fromEntries(Object.entries(item).filter(([key]) =>
      !['id', 'name', 'description', 'protocol', 'entry', 'locales'].includes(key) && !RESERVED_KEYS.has(key)));
    harnesses.push({
      ...extensions,
      id,
      name: item.name,
      ...(item.description !== undefined ? { description: item.description as string } : {}),
      protocol: item.protocol,
      entry: item.entry,
      ...(locales ? { locales } : {}),
    });
  }
  return { ok: true, harnesses };
}

/** Declared engines this Host can run (protocol known). */
export function activeGhostHarnesses(
  manifest: { harnesses?: readonly GhostHarnessDecl[]; node?: unknown },
): GhostHarnessDecl[] {
  if (!manifest.node) return [];
  return (manifest.harnesses ?? []).filter((harness) =>
    (GHOST_HARNESS_PROTOCOLS as readonly string[]).includes(harness.protocol));
}

/** Text for a locale: exact match, then the same language, then the declared default. */
export function ghostHarnessText(
  harness: Pick<GhostHarnessDecl, 'name' | 'description' | 'locales'>,
  locale: string,
): { name: string; description?: string } {
  const entries = Object.entries(harness.locales ?? {});
  const language = locale.split('-')[0]?.toLowerCase();
  const text = Object.prototype.hasOwnProperty.call(harness.locales ?? {}, locale)
    ? harness.locales![locale]
    : entries.find(([key]) => key.split('-')[0]?.toLowerCase() === language)?.[1];
  const description = text?.description ?? harness.description;
  return { name: text?.name ?? harness.name, ...(description !== undefined ? { description } : {}) };
}

/* ── Runtime availability (`PUT /harnesses`) ─────────────────────────────── */

export interface GhostHarnessAvailability {
  id: string;
  available: boolean;
  /** Short machine-readable slug, e.g. `not-installed`. */
  reason?: string;
  /** Plugin-written text shown as-is, e.g. an install hint. */
  message?: string;
  /** Version of the external agent the plugin detected. */
  version?: string;
  /**
   * The engine's models as its plugin lists them (the picker shows them like a provider's models).
   * `id` is the value the engine itself accepts when a task picks that model. Absent = the plugin
   * does not list models; Cindy then shows what the engine reported the last time a task ran.
   */
  models?: GhostHarnessModel[];
  /**
   * The agent's own working modes, as Cindy permission mode ids, in the agent's order. For an ACP
   * engine these are its `mode` option values that name a Cindy mode (`accept-edits` → acceptEdits).
   * Cindy shows them in the permission menu followed by its own Full access. Absent = Cindy's
   * generic Ask each time / Full access.
   */
  modes?: GhostHarnessMode[];
  /** The mode the agent starts in; must be one of `modes`. */
  defaultMode?: GhostHarnessMode;
}

/** Cindy permission modes an agent's own mode can stand for (Full access is always Cindy's). */
export const GHOST_HARNESS_MODES = ['default', 'acceptEdits', 'auto', 'plan'] as const;
export type GhostHarnessMode = (typeof GHOST_HARNESS_MODES)[number];
const HARNESS_MODES_MAX = 16;

export interface GhostHarnessModel {
  id: string;
  name: string;
  description?: string;
  group?: string;
  /**
   * Reasoning levels the engine offers for this model, as Cindy level ids (low → high order is
   * restored by Cindy). For an ACP engine these are the values of its `thought_level` option that
   * equal a Cindy level id; other values have no Cindy level and are left out. Absent = the model
   * has no selectable level (or the plugin does not know).
   */
  efforts?: GhostHarnessEffort[];
  /** The level the engine uses when none is chosen; must be one of `efforts`. */
  defaultEffort?: GhostHarnessEffort;
}

/** Cindy reasoning levels a plugin engine can offer, low → high (same set maker-core maps from ACP). */
export const GHOST_HARNESS_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type GhostHarnessEffort = (typeof GHOST_HARNESS_EFFORTS)[number];

export const GHOST_HARNESS_MODELS_MAX = 200;
const MODEL_EFFORTS_MAX = 16;
const REASON_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MESSAGE_MAX = 200;
const VERSION_MAX = 64;
const MODEL_ID_MAX = 256;
const MODEL_TEXT_MAX = 200;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f]/;
// eslint-disable-next-line no-control-regex
const ANY_CONTROL_RE = /[\u0000-\u001f\u007f]/;

export type GhostHarnessAvailabilityParse =
  | { ok: true; harnesses: GhostHarnessAvailability[] }
  | { ok: false; reason: string };

/**
 * Validate a published availability list. The list replaces the stored one as a whole; any
 * malformed entry or an id the manifest does not declare rejects the whole request. Only
 * metadata is accepted: fields other than the documented ones are dropped, never stored.
 */
export function parseGhostHarnessAvailability(
  raw: unknown,
  declaredIds: readonly string[],
): GhostHarnessAvailabilityParse {
  if (!isRecord(raw) || !Array.isArray(raw.harnesses)) return { ok: false, reason: 'Expected { "harnesses": [...] }' };
  if (raw.harnesses.length > GHOST_HARNESSES_MAX) {
    return { ok: false, reason: `At most ${GHOST_HARNESSES_MAX} harnesses can be published` };
  }
  const harnesses: GhostHarnessAvailability[] = [];
  const seen = new Set<string>();
  for (const item of raw.harnesses) {
    if (!isRecord(item) || typeof item.id !== 'string' || !declaredIds.includes(item.id)) {
      return { ok: false, reason: 'Each entry needs the id of a harness declared in ghost.json' };
    }
    const { id } = item;
    if (seen.has(id)) return { ok: false, reason: `Duplicate harness id ${id}` };
    seen.add(id);
    if (typeof item.available !== 'boolean') return { ok: false, reason: `Harness ${id} needs available: true or false` };
    if (item.reason !== undefined && (typeof item.reason !== 'string' || !REASON_RE.test(item.reason))) {
      return { ok: false, reason: `Harness ${id} reason must be a short lowercase slug` };
    }
    if (item.message !== undefined && (!isText(item.message, MESSAGE_MAX) || CONTROL_RE.test(item.message))) {
      return { ok: false, reason: `Harness ${id} message must be 1–${MESSAGE_MAX} characters of plain text` };
    }
    if (item.version !== undefined && (!isText(item.version, VERSION_MAX) || ANY_CONTROL_RE.test(item.version))) {
      return { ok: false, reason: `Harness ${id} version must be 1–${VERSION_MAX} characters` };
    }
    let models: GhostHarnessModel[] | undefined;
    if (item.models !== undefined) {
      const parsedModels = parseHarnessModels(item.models);
      if (!parsedModels.ok) return { ok: false, reason: `Harness ${id} models: ${parsedModels.reason}` };
      models = parsedModels.models;
    }
    const modes = parseHarnessModes(item.modes, item.defaultMode);
    if (!modes.ok) return { ok: false, reason: `Harness ${id} ${modes.reason}` };
    harnesses.push({
      id,
      available: item.available as boolean,
      ...(item.reason !== undefined ? { reason: item.reason as string } : {}),
      ...(item.message !== undefined ? { message: item.message as string } : {}),
      ...(item.version !== undefined ? { version: item.version as string } : {}),
      ...(models !== undefined ? { models } : {}),
      ...modes.fields,
    });
  }
  return { ok: true, harnesses };
}

function plainText(value: unknown, max: number): value is string {
  return isText(value, max) && !ANY_CONTROL_RE.test(value);
}

/** Model list of one engine: unique ids, plain-text names; extra fields are dropped. */
function parseHarnessModels(raw: unknown): { ok: true; models: GhostHarnessModel[] } | { ok: false; reason: string } {
  if (!Array.isArray(raw)) return { ok: false, reason: 'expected an array' };
  if (raw.length > GHOST_HARNESS_MODELS_MAX) return { ok: false, reason: `at most ${GHOST_HARNESS_MODELS_MAX} models` };
  const models: GhostHarnessModel[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!isRecord(entry) || !plainText(entry.id, MODEL_ID_MAX) || !plainText(entry.name, MODEL_TEXT_MAX)) {
      return { ok: false, reason: `each model needs an id (1–${MODEL_ID_MAX}) and a name (1–${MODEL_TEXT_MAX})` };
    }
    if (seen.has(entry.id)) return { ok: false, reason: `duplicate model id ${entry.id}` };
    seen.add(entry.id);
    if (entry.description !== undefined && !plainText(entry.description, MODEL_TEXT_MAX)) {
      return { ok: false, reason: `model ${entry.id} description must be 1–${MODEL_TEXT_MAX} characters` };
    }
    if (entry.group !== undefined && !plainText(entry.group, MODEL_TEXT_MAX)) {
      return { ok: false, reason: `model ${entry.id} group must be 1–${MODEL_TEXT_MAX} characters` };
    }
    const efforts = parseModelEfforts(entry.efforts, entry.defaultEffort);
    if (!efforts.ok) return { ok: false, reason: `model ${entry.id} ${efforts.reason}` };
    models.push({
      id: entry.id,
      name: entry.name,
      ...(entry.description !== undefined ? { description: entry.description as string } : {}),
      ...(entry.group !== undefined ? { group: entry.group as string } : {}),
      ...efforts.fields,
    });
  }
  return { ok: true, models };
}

/**
 * An engine's working modes: malformed values reject the report; ids this Cindy does not know are
 * skipped (forward compatible), duplicates folded, the agent's order kept. A default that is not
 * offered is dropped.
 */
function parseHarnessModes(
  rawModes: unknown,
  rawDefault: unknown,
): { ok: true; fields: Pick<GhostHarnessAvailability, 'modes' | 'defaultMode'> } | { ok: false; reason: string } {
  if (rawModes === undefined) {
    return rawDefault === undefined ? { ok: true, fields: {} } : { ok: false, reason: 'defaultMode needs modes' };
  }
  if (!Array.isArray(rawModes) || rawModes.length > HARNESS_MODES_MAX
    || !rawModes.every((value) => typeof value === 'string' && value.length > 0 && value.length <= 32)) {
    return { ok: false, reason: `modes must be an array of at most ${HARNESS_MODES_MAX} mode ids` };
  }
  if (rawDefault !== undefined && (typeof rawDefault !== 'string' || rawDefault.length === 0 || rawDefault.length > 32)) {
    return { ok: false, reason: 'defaultMode must be a mode id' };
  }
  const modes: GhostHarnessMode[] = [];
  for (const value of rawModes as string[]) {
    const known = GHOST_HARNESS_MODES.find((mode) => mode === value);
    if (known && !modes.includes(known)) modes.push(known);
  }
  if (modes.length === 0) return { ok: true, fields: {} };
  const defaultMode = modes.find((mode) => mode === rawDefault);
  return { ok: true, fields: { modes, ...(defaultMode ? { defaultMode } : {}) } };
}

function isHarnessEffort(value: unknown): value is GhostHarnessEffort {
  return typeof value === 'string' && (GHOST_HARNESS_EFFORTS as readonly string[]).includes(value);
}

/**
 * A model's reasoning levels. Malformed values reject the report; level ids this Cindy does not
 * know are skipped (a plugin written for a newer Cindy keeps its models here), duplicates are
 * folded and the order is Cindy's low → high. A default that is not offered is dropped.
 */
function parseModelEfforts(
  rawEfforts: unknown,
  rawDefault: unknown,
): { ok: true; fields: Pick<GhostHarnessModel, 'efforts' | 'defaultEffort'> } | { ok: false; reason: string } {
  if (rawEfforts === undefined) {
    return rawDefault === undefined ? { ok: true, fields: {} } : { ok: false, reason: 'defaultEffort needs efforts' };
  }
  if (!Array.isArray(rawEfforts) || rawEfforts.length > MODEL_EFFORTS_MAX
    || !rawEfforts.every((value) => typeof value === 'string' && value.length > 0 && value.length <= 32)) {
    return { ok: false, reason: `efforts must be an array of at most ${MODEL_EFFORTS_MAX} level ids` };
  }
  if (rawDefault !== undefined && (typeof rawDefault !== 'string' || rawDefault.length === 0 || rawDefault.length > 32)) {
    return { ok: false, reason: 'defaultEffort must be a level id' };
  }
  const efforts = GHOST_HARNESS_EFFORTS.filter((level) => rawEfforts.includes(level));
  if (efforts.length === 0) return { ok: true, fields: {} };
  const defaultEffort = isHarnessEffort(rawDefault) && efforts.includes(rawDefault) ? rawDefault : undefined;
  return { ok: true, fields: { efforts, ...(defaultEffort ? { defaultEffort } : {}) } };
}

/**
 * Read a stored list against the current manifest: entries for engines it no longer declares are
 * dropped, and a damaged file reads as "nothing published" (each engine then shows as unknown).
 */
export function storedGhostHarnessAvailability(
  raw: unknown,
  declaredIds: readonly string[],
): GhostHarnessAvailability[] {
  if (!isRecord(raw) || !Array.isArray(raw.harnesses)) return [];
  const kept = raw.harnesses.filter((item) =>
    isRecord(item) && typeof item.id === 'string' && declaredIds.includes(item.id));
  const parsed = parseGhostHarnessAvailability({ harnesses: kept }, declaredIds);
  return parsed.ok ? parsed.harnesses : [];
}
