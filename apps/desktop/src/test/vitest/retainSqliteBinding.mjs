import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export default function retainSqliteBinding() {
  // Keep a main-environment dlopen reference until worker teardown finishes.
  // ObjectWrap weak callbacks can otherwise outlive the unloaded native image.
  // Loading the binding does not construct a Database or replace its API.
  require('better-sqlite3/build/Release/better_sqlite3.node');
}
