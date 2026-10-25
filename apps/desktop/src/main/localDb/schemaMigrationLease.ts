import { readSchemaMigrationBootIdentity } from './schemaMigrationBootIdentity';
import { setSchemaMigrationBootIdentityReader } from '@cindy/runtime-db/schemaMigrationBootIdentity';

setSchemaMigrationBootIdentityReader(readSchemaMigrationBootIdentity);
export * from '@cindy/runtime-db/schemaMigrationLease';
