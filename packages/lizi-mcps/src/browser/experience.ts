import { z } from 'zod';
import { deferredRecipeIssue, type MergedRecipe } from './recipe-loader.js';

/** Persist only execution shape and counters, never URLs, selectors, scripts or values. */
export const BrowserExperienceSchema = z.object({
  site: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/),
  actions: z
    .array(z.enum(['navigate', 'click', 'type', 'select', 'press', 'wait', 'extract', 'evaluate']))
    .min(2)
    .max(32),
  observations: z.number().int().positive(),
  updatedAt: z.number().finite(),
});
export type BrowserExperience = z.infer<typeof BrowserExperienceSchema>;
export type ExperienceAction = BrowserExperience['actions'][number];

export interface BrowserExperienceStore {
  record(input: Pick<BrowserExperience, 'site' | 'actions'>): Promise<BrowserExperience>;
  list(site: string): Promise<BrowserExperience[]>;
}

/** A bounded per-task trace; navigation starts a flow, the first successful read ends it. */
export class BrowserExperienceRecorder {
  private readonly flows = new Map<string, { site: string; actions: ExperienceAction[] }>();

  clear(target?: string): void {
    if (target === undefined) this.flows.clear();
    else this.flows.delete(target);
  }

  start(target: string, url: string): void {
    this.clear(target);
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password)
        return;
      if (!BrowserExperienceSchema.shape.site.safeParse(parsed.hostname).success) return;
      if (this.flows.size >= 32) this.flows.delete(this.flows.keys().next().value!);
      this.flows.set(target, { site: parsed.hostname, actions: ['navigate'] });
    } catch {
      /* Not an observable web flow. */
    }
  }

  step(
    target: string,
    action: ExperienceAction,
  ): Pick<BrowserExperience, 'site' | 'actions'> | undefined {
    const flow = this.flows.get(target);
    if (!flow) return;
    if (flow.actions.length >= 32) {
      this.clear(target);
      return;
    }
    flow.actions.push(action);
    if (action !== 'extract' && action !== 'evaluate') return;
    this.clear(target);
    return flow;
  }
}

/** Host matching is boundary-aware. A match only suggests a recipe, never executes it. */
export function suggestRecipes(
  recipes: Map<string, MergedRecipe>,
  site: string,
  intent = '',
  profile = '',
) {
  const terms = intent
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  return [...recipes.values()]
    .filter(({ recipe }) => {
      if (recipe.validation?.state === 'suspended') return false;
      if (recipe.validation?.state === 'candidate' && deferredRecipeIssue(recipe)) return false;
      if (recipe.validation?.profile !== undefined && recipe.validation.profile !== profile)
        return false;
      return [recipe.validation?.site, ...(recipe.match ?? [])].some((host) => {
        if (!host) return false;
        const normalized = host.toLowerCase().replace(/^www\./, '');
        return site === normalized || site.endsWith(`.${normalized}`);
      });
    })
    .map((entry) => {
      const haystack = `${entry.recipe.id} ${entry.recipe.description ?? ''}`.toLowerCase();
      return { ...entry, score: terms.filter((term) => haystack.includes(term)).length };
    })
    .sort((a, b) => b.score - a.score || a.recipe.id.localeCompare(b.recipe.id))
    .filter((entry) => !terms.length || entry.score > 0)
    .slice(0, 3)
    .map(({ recipe, provenance }) => ({
      id: recipe.id,
      description: recipe.description?.slice(0, 240),
      access: recipe.access ?? 'unspecified',
      state: recipe.validation?.state ?? 'active',
      provenance,
      inputs: recipe.inputs,
    }));
}
