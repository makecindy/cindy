import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

import type Database from 'better-sqlite3';

interface CompanionMigration {
  run(db: Database.Database): void;
}

/**
 * Companion migrations are frozen raw TypeScript loaded by production with Node type stripping.
 * The repository's supported test Node may require an opt-in process flag that Vitest cannot add
 * after startup, so tests transpile the exact frozen source in memory and execute its CommonJS body.
 */
export function loadCompanionMigrationForTest(scriptPath: string): CompanionMigration {
  const source = fs.readFileSync(scriptPath, 'utf8');
  const output = ts.transpileModule(source, {
    fileName: scriptPath,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  const moduleRecord: { exports: unknown } = { exports: {} };
  const localRequire = createRequire(scriptPath);
  const execute = new Function(
    'module',
    'exports',
    'require',
    '__filename',
    '__dirname',
    output,
  ) as (
    module: { exports: unknown },
    exports: unknown,
    require: NodeJS.Require,
    filename: string,
    dirname: string,
  ) => void;
  execute(
    moduleRecord,
    moduleRecord.exports,
    localRequire,
    scriptPath,
    path.dirname(scriptPath),
  );
  const migration = moduleRecord.exports as Partial<CompanionMigration>;
  if (typeof migration.run !== 'function') {
    throw new Error(`companion migration did not export run(): ${scriptPath}`);
  }
  return migration as CompanionMigration;
}
