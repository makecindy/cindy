/**
 * Models a plugin adds to the model picker.
 *
 * The manifest declares the capability (`models.types`); the list itself is published at runtime,
 * because what a plugin offers usually depends on what the user configured inside it. Hosts store
 * the latest valid list and read that, so opening the picker never waits on a plugin.
 */

/** Target types this Host can run. Others stay in the declaration but publish nothing. */
export const GHOST_MODEL_TARGET_TYPES = ['route'] as const;
export type GhostModelTargetType = (typeof GHOST_MODEL_TARGET_TYPES)[number];

export interface GhostModelsNeeds {
  types: string[];
}

export interface GhostPublishedModelText {
  name?: string;
  description?: string;
}

export interface GhostPublishedModel {
  id: string;
  name: string;
  description?: string;
  /** Text by locale, so a language change needs no plugin call. */
  locales?: Record<string, GhostPublishedModelText>;
  /** route: on a new task the plugin answers with a real model through `will-start-task`. */
  target: { type: GhostModelTargetType };
}

export const GHOST_PUBLISHED_MODELS_MAX = 16;
const NAME_MAX = 64;
const DESCRIPTION_MAX = 200;
const LOCALES_MAX = 16;
const MODEL_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const TYPE_RE = /^[a-z][a-z0-9-]{0,31}$/;
const LOCALE_RE = /^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{1,8}){0,3}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isText = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max;

export function parseGhostModelsNeeds(raw: unknown): GhostModelsNeeds | null {
  if (!isRecord(raw) || !Array.isArray(raw.types) || raw.types.length === 0) return null;
  const types = raw.types;
  if (!types.every((type) => typeof type === 'string' && TYPE_RE.test(type))) return null;
  if (new Set(types).size !== types.length) return null;
  return { types: types as string[] };
}

function parseText(raw: Record<string, unknown>): GhostPublishedModelText | null {
  if (raw.name !== undefined && !isText(raw.name, NAME_MAX)) return null;
  if (raw.description !== undefined && !isText(raw.description, DESCRIPTION_MAX)) return null;
  return {
    ...(raw.name !== undefined ? { name: raw.name as string } : {}),
    ...(raw.description !== undefined ? { description: raw.description as string } : {}),
  };
}

export type GhostPublishedModelsParse =
  | { ok: true; models: GhostPublishedModel[]; skipped: string[] }
  | { ok: false; reason: string };

/**
 * A malformed list is rejected whole. A well-formed model this Host or manifest cannot run is only
 * skipped, so a plugin built for a newer Host still gets the models that do work here.
 */
export function parseGhostPublishedModels(raw: unknown, declaredTypes: readonly string[]): GhostPublishedModelsParse {
  if (!isRecord(raw) || !Array.isArray(raw.models)) return { ok: false, reason: 'Expected { "models": [...] }' };
  if (raw.models.length > GHOST_PUBLISHED_MODELS_MAX) {
    return { ok: false, reason: `At most ${GHOST_PUBLISHED_MODELS_MAX} models can be published` };
  }
  const models: GhostPublishedModel[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  for (const item of raw.models) {
    if (!isRecord(item) || typeof item.id !== 'string' || !MODEL_ID_RE.test(item.id)) {
      return { ok: false, reason: 'Each model needs an id of letters, digits, dots, dashes or underscores' };
    }
    const { id } = item;
    if (seen.has(id)) return { ok: false, reason: `Duplicate model id ${id}` };
    seen.add(id);
    if (!isText(item.name, NAME_MAX)) return { ok: false, reason: `Model ${id} needs a name of up to ${NAME_MAX} characters` };
    if (item.description !== undefined && !isText(item.description, DESCRIPTION_MAX)) {
      return { ok: false, reason: `Model ${id} has a description over ${DESCRIPTION_MAX} characters` };
    }
    if (!isRecord(item.target) || typeof item.target.type !== 'string') {
      return { ok: false, reason: `Model ${id} needs target.type` };
    }
    let locales: Record<string, GhostPublishedModelText> | undefined;
    if (item.locales !== undefined) {
      if (!isRecord(item.locales) || Object.keys(item.locales).length > LOCALES_MAX) {
        return { ok: false, reason: `Model ${id} has invalid locales` };
      }
      locales = {};
      for (const [locale, value] of Object.entries(item.locales)) {
        const text = LOCALE_RE.test(locale) && isRecord(value) ? parseText(value) : null;
        if (!text) return { ok: false, reason: `Model ${id} has invalid text for locale ${locale}` };
        locales[locale] = text;
      }
    }
    const type = item.target.type;
    if (!(GHOST_MODEL_TARGET_TYPES as readonly string[]).includes(type) || !declaredTypes.includes(type)) {
      skipped.push(id);
      continue;
    }
    models.push({
      id,
      name: item.name,
      ...(item.description !== undefined ? { description: item.description as string } : {}),
      ...(locales ? { locales } : {}),
      target: { type: type as GhostModelTargetType },
    });
  }
  return { ok: true, models, skipped };
}

/** Text for a locale: exact match, then the same language, then the published default. */
export function ghostPublishedModelText(
  model: GhostPublishedModel,
  locale: string,
): { name: string; description?: string } {
  const entries = Object.entries(model.locales ?? {});
  const language = locale.split('-')[0]?.toLowerCase();
  const text = model.locales?.[locale]
    ?? entries.find(([key]) => key.split('-')[0]?.toLowerCase() === language)?.[1];
  const description = text?.description ?? model.description;
  return { name: text?.name ?? model.name, ...(description !== undefined ? { description } : {}) };
}
