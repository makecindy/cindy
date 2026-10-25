import { createLogger } from '../logger';
import { createSchemaDriftRepair } from '@cindy/runtime-db/schemaDriftRepair';
export type { ResidualMismatch, RepairReport, SchemaDriftRepairAction, SchemaDriftRepairPlan, GuardedSchemaDriftRepairOptions, GuardedSchemaDriftRepairResult } from '@cindy/runtime-db/schemaDriftRepair';
export const { getManagedSchemaTableNames, planSchemaDriftRepair, applySchemaDriftRepair, repairSchemaDriftWithBackup, repairSchemaDrift } = createSchemaDriftRepair(createLogger('schema-drift-repair'));
