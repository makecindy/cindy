import { MobilePluginPages as SharedMobilePluginPages, type MobilePluginPageDependencies } from '@cindy/plugin-runtime/mobilePageService';
import { t } from '../i18n.js';
export class MobilePluginPages extends SharedMobilePluginPages {
  constructor(deps: Omit<MobilePluginPageDependencies, 'translate'>) {
    super({ ...deps, translate: t });
  }
}
