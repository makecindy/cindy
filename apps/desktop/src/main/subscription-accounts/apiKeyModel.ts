import { CHATGPT_MODEL_PREFIX } from '@cindy/model-providers/classification';

/** The Pi subscription namespace is a task ID, not an official API wire ID. */
export function apiKeyEngineModel(model: string, agent: string): string {
  return agent === 'pi' && model.startsWith(CHATGPT_MODEL_PREFIX) ? model.slice(CHATGPT_MODEL_PREFIX.length) : model;
}
