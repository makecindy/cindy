import type { ModelDescriptor } from '../../types/capabilities.js';
import type { Effort } from '../../types/common.js';
import { cursorModelGroup } from '@cindy/model-providers';

export type AcpRecord = Record<string, unknown>;
export function record(value: unknown): AcpRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as AcpRecord : {};
}
export interface CursorModelOption { id: string; name: string; description?: string; group?: string }
export interface CursorConfigOption {
  id: string;
  category?: string;
  type: 'select' | 'boolean';
  currentValue?: string | boolean;
  options: CursorModelOption[];
}
const EFFORTS: readonly Effort[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

export function readCursorConfigOptions(value: unknown): CursorConfigOption[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(raw => {
    const option = record(raw);
    if (typeof option.id !== 'string' || !option.id) return [];
    const choices: CursorModelOption[] = [];
    const collect = (options: unknown): void => {
      if (!Array.isArray(options)) return;
      for (const raw of options) {
        const item = record(raw);
        if (Array.isArray(item.options)) collect(item.options);
        else if (typeof item.value === 'string' && item.value.trim()) {
          choices.push({ id: item.value, name: typeof item.name === 'string' ? item.name : item.value });
        }
      }
    };
    collect(option.options);
    if (option.type !== undefined && option.type !== 'select' && option.type !== 'boolean') return [];
    return [{ id: option.id, category: typeof option.category === 'string' ? option.category : undefined,
      type: option.type === 'boolean' ? 'boolean' as const : 'select' as const,
      currentValue: typeof option.currentValue === 'string' || typeof option.currentValue === 'boolean' ? option.currentValue : undefined,
      options: [...new Map(choices.map(item => [item.id, item])).values()] }];
  });
}

/** Keep opaque config IDs/values intact; only standard Cindy effort values map to its slider. */
export function readCursorModelControls(configs: unknown) {
  const options = readCursorConfigOptions(configs);
  const effort = options.find(option => option.category === 'thought_level' && option.type === 'select'
    && option.options.some(item => EFFORTS.includes(item.id as Effort)));
  const efforts = EFFORTS.filter(value => effort?.options.some(item => item.id === value));
  const fast = options.find(option => option.id === 'fast'
    && (option.category === 'model_config' || option.category === '_model_config')
    && (option.type === 'boolean' || ['false', 'true'].every(value => option.options.some(item => item.id === value))));
  return { effort, efforts, fast };
}
export interface CursorModelCatalog {
  models: ModelDescriptor[];
  configId?: string;
  currentModel?: string;
}

/** Only advertise models the running CLI has actually offered. No guessed AUTO catalog. */
export function readCursorModels(session: unknown, parameterizedModels?: unknown): CursorModelCatalog {
  const data = record(session);
  const configs = Array.isArray(data.configOptions) ? data.configOptions : [];
  const config = configs.map(record).find(option => option.category === 'model');
  const choices: CursorModelOption[] = [];
  function collect(options: unknown, group?: string): void {
    if (!Array.isArray(options)) return;
    for (const raw of options) {
      const option = record(raw);
      if (Array.isArray(option.options)) collect(option.options, typeof option.name === 'string' ? option.name : group);
      else if (typeof option.value === 'string' && option.value.trim()) {
        choices.push({ id: option.value, name: typeof option.name === 'string' ? option.name : option.value,
          ...(typeof option.description === 'string' ? { description: option.description } : {}),
          ...(group ? { group } : {}),
        });
      }
    }
  }
  collect(config?.options);
  // Older ACP agents expose SessionModelState. Discovery is useful even when
  // their experimental model mutation method is unavailable: don't guess it.
  const legacy = record(data.models);
  if (!choices.length && Array.isArray(legacy.availableModels)) {
    for (const raw of legacy.availableModels) {
      const item = record(raw);
      if (typeof item.modelId === 'string' && item.modelId.trim()) {
        choices.push({ id: item.modelId, name: typeof item.name === 'string' ? item.name : item.modelId,
          ...(typeof item.description === 'string' ? { description: item.description } : {}),
        });
      }
    }
  }
  const current = config?.currentValue ?? legacy.currentModelId;
  const currentModel = typeof current === 'string' && current.trim() ? current : undefined;
  const parameters = new Map((Array.isArray(parameterizedModels) ? parameterizedModels : [])
    .map(record).filter(item => typeof item.value === 'string').map(item => [item.value, item.configOptions]));
  return {
    configId: typeof config?.id === 'string' ? config.id : undefined,
    currentModel,
    models: [...new Map(choices.map(item => [item.id, item])).values()].map((item, sortOrder) => {
      const defaults = readCursorModelControls(parameters.get(item.id));
      const controls = item.id === currentModel ? readCursorModelControls(configs) : defaults;
      const defaultEffort = defaults.effort?.currentValue ?? controls.effort?.currentValue;
      const group = cursorModelGroup(item.id, item.name, item.group);
      return { id: item.id, displayName: item.name, contextWindow: 0,
        sortOrder,
        ...(group ? { group } : {}),
        ...(item.description !== undefined ? { description: item.description } : {}),
        efforts: controls.efforts,
        defaultEffort: typeof defaultEffort === 'string' && controls.efforts.includes(defaultEffort as Effort) ? defaultEffort as Effort : null,
        supportsFastMode: controls.fast !== undefined,
        ...(item.id === currentModel ? { newSessionDefault: ['cursor' as const] } : {}),
      };
    }),
  };
}

/** A sentinel meaning “let this CLI choose”; it is not an AUTO model claim. */
export const CURSOR_DEFAULT_MODEL = 'cursor-default';
export const cursorDefaultModel: ModelDescriptor = {
  id: CURSOR_DEFAULT_MODEL, displayName: 'Cursor Default', contextWindow: 0,
  efforts: [], defaultEffort: null, supportsFastMode: false,
  defaultEnabled: false,
};
