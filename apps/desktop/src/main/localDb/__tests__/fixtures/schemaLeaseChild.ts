import fs from 'node:fs';
import Module, { createRequire } from 'node:module';

// Bootstrap the child with the parent's simulated boot generation. Keep real
// filesystem/process leases without repeatedly launching OS probes per child.
// Install this one dependency before loading the production lease module once.
const fixtureRequire = createRequire(__filename);
const bootModulePath = fixtureRequire.resolve('../../schemaMigrationBootIdentity');
const bootModule = new Module(bootModulePath);
bootModule.exports = {
  readSchemaMigrationBootIdentity: async () => 'test:11111111-1111-1111-1111-111111111111',
};
bootModule.loaded = true;
fixtureRequire.cache[bootModulePath] = bootModule;
const {
  acquireSchemaMigrationReaderLease,
  acquireSchemaMigrationWriterLease,
}: typeof import('../../schemaMigrationLease') = fixtureRequire('../../schemaMigrationLease');

const [dbFilePath, kind, mode] = process.argv.slice(2);
if (!dbFilePath || (kind !== 'reader' && kind !== 'writer')) {
  throw new Error('usage: schemaLeaseChild <db-path> <reader|writer>');
}

async function main() {
  if (mode === 'compete') {
    await new Promise<void>((resolve) => {
      process.once('message', () => resolve());
      process.send?.({ type: 'prepared' });
    });
  }
  if (mode === 'crash-after-gate-publish') {
    const rename = fs.renameSync;
    fs.renameSync = (from, to) => {
      rename(from, to);
      if (to === `${dbFilePath}.schema-transition`) process.exit(17);
    };
  }
  if (mode === 'crash-during-gate-release') {
    const rmdir = fs.rmdirSync;
    fs.rmdirSync = (directory) => {
      if (directory === `${dbFilePath}.schema-transition`) process.exit(17);
      rmdir(directory);
    };
  }
  if (mode === 'crash-before-publish' || mode === 'crash-after-publish') {
    const link = fs.linkSync;
    fs.linkSync = (from, to) => {
      if (to === `${dbFilePath}.schema-writer.lock`) {
        if (mode === 'crash-after-publish') link(from, to);
        process.exit(17);
      }
      link(from, to);
    };
  }
  const result =
    kind === 'reader'
      ? await acquireSchemaMigrationReaderLease(dbFilePath)
      : await acquireSchemaMigrationWriterLease(dbFilePath);
  if (!result.acquired) {
    process.send?.({ type: 'failed', reason: result.reason });
    process.exit(2);
  }

  process.send?.({ type: 'ready', kind });
  process.on('message', (message) => {
    if (message !== 'release') return;
    result.lease.release();
    process.exit(0);
  });
  setInterval(() => undefined, 60_000);
}
void main();
