import { createProjectAutomationLoader } from '@cindy/app-runtime/projectAutomationLoader';
import { projectAutomationConsentToRow } from '../localDb/mapper';
import { migrateLegacyXdmakerDir } from '../utils/legacyXdmakerMigration';
export type * from '@cindy/app-runtime/projectAutomationLoader';
export const { ProjectAutomationLoader, schedulesDiffer, __testing } =
  createProjectAutomationLoader({
    projectAutomationConsentToRow: (...args) => projectAutomationConsentToRow(...args),
    migrateLegacyXdmakerDir: (...args) => migrateLegacyXdmakerDir(...args),
  });
export type ProjectAutomationLoader =
  import('@cindy/app-runtime/projectAutomationLoader').ProjectAutomationLoader;
