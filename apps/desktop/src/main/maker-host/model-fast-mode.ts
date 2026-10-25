import { createModelFastMode } from '@cindy/model-providers/modelFastMode';
import { getActiveCatalog } from './active-catalog.js';

export const { fastModelId, rewriteFastModel } = createModelFastMode(getActiveCatalog);
