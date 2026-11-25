import { createContext, useContext } from 'react';
import type { AgentKind, Effort, ProviderView } from '@cindy/model-providers';

import type {
  isModelEnabled,
  isModelVisibilityCustomized,
  resetModelVisibilities,
  setModelVisibilities,
} from '@/state/modelVisibilityPrefs';
import type { CustomModelEdit } from '../../../shared/customModelEdit';

type Maker = Window['electronAPI']['maker'];

/**
 * Model settings of another device (the cloud instance settings page). Absent on the local
 * page, where the model list, model panel and price dialog use this device's stores.
 */
export interface ModelSettingsSource {
  visibilityVersion: number;
  isModelEnabled: typeof isModelEnabled;
  isModelVisibilityCustomized: typeof isModelVisibilityCustomized;
  setModelVisibilities: typeof setModelVisibilities;
  resetModelVisibilities: typeof resetModelVisibilities;
  setModelDisable(input: Parameters<Maker['setModelDisable']>[0]): Promise<unknown>;
  getEffort(agent: AgentKind, providerId: string, modelId: string): Effort | undefined;
  /** null clears the remembered effort, as the panel's reset does. */
  setEffort(agent: AgentKind, providerId: string, modelId: string, effort: Effort | null): void;
  /** Resolves false when the device did not save the edit. */
  editModel(
    provider: ProviderView,
    agent: AgentKind,
    modelId: string,
    edit: CustomModelEdit,
  ): Promise<boolean>;
  /** Context limit and price override calls, in the local preload shapes. */
  maker: Pick<
    Maker,
    | 'getModelContextLimit'
    | 'setModelContextLimit'
    | 'resetModelContextLimit'
    | 'setModelCompaction'
    | 'getModelPriceOverride'
    | 'setModelPriceOverride'
    | 'resetModelPriceOverride'
  > &
    /** Absent when the device's runtime predates the image-input override. */
    Partial<Pick<Maker, 'getModelImageInputOverride' | 'setModelImageInputOverride'>>;
}

export const ModelSettingsSourceContext = createContext<ModelSettingsSource | null>(null);

export function useModelSettingsSource(): ModelSettingsSource | null {
  return useContext(ModelSettingsSourceContext);
}
