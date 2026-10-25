import { createLogger } from '../logger';
import { getDrizzleDir } from './migrate';
import { createSchemaDriftDetector } from '@cindy/runtime-db/schemaDriftDetector';
export type { DriftEntry, DriftReport, DriftStatus } from '@cindy/runtime-db/schemaDriftDetector';
export const { detectSchemaDrift } = createSchemaDriftDetector(getDrizzleDir, createLogger('schema-drift-detector'));
