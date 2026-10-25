import { createLogger } from '../../logger.js';
import { DbErrorBoundary as SharedDbErrorBoundary, type DbErrorBoundaryOptions as SharedOptions } from '@cindy/runtime-db/client/DbErrorBoundary';

export type DbErrorBoundaryOptions = Omit<SharedOptions, 'logger'>;
export class DbErrorBoundary extends SharedDbErrorBoundary {
  constructor(options: DbErrorBoundaryOptions = {}) {
    super({ ...options, logger: createLogger('db-worker') });
  }
}
