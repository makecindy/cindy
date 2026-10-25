import { createLegacyXdmakerMigration } from '@cindy/app-runtime/legacyXdmakerMigration';
import { createLogger } from '../logger.js';
export type { MigrationResult } from '@cindy/app-runtime/legacyXdmakerMigration';
export { LEGACY_DIR_NAME, CINDY_DIR_NAME } from '@cindy/app-runtime/legacyXdmakerMigration';
export const { migrateLegacyXdmakerDir, resetLegacyXdmakerMigrationCacheForTest } =
  createLegacyXdmakerMigration(createLogger('legacy-xdmaker-migration'));
