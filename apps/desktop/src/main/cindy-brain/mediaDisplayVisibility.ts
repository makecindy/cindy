import {getActiveCatalog} from '../maker-host/active-catalog.js';
import {getModelVisibilityOverride} from '../maker-host/model-visibility-mirror.js';
import {createMediaDisplayVisibility} from '@cindy/app-runtime/media/mediaDisplayVisibility';
export const {isCatalogMediaModelVisible}=createMediaDisplayVisibility({getActiveCatalog,getModelVisibilityOverride});
