import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { copyRuntimeDependencyTrees } from '../../../../../forge-runtime-deps.ts';
import { prunePackagedRuntime } from '../../../../../forge-prune-runtime.ts';
import { READ_SHEET_RUNTIME_PACKAGES } from '../../../../../../../packages/lizi-mcps/src/cindy-docs/readSheetRuntimeDeps.ts';

// Run the real synchronous packaging helpers outside Vitest's RPC worker.
const [desktopRoot, temp] = process.argv.slice(2);
const workspaceRequire = createRequire(import.meta.url);

function packageDirectory(name, fromDirs) {
  const options = fromDirs ? { paths: fromDirs } : { paths: [desktopRoot] };
  try {
    return path.dirname(workspaceRequire.resolve(`${name}/package.json`, options));
  } catch {
    try {
      return path.dirname(workspaceRequire.resolve(`${name}/package`, options));
    } catch {
      // Some packages export their manifest as ./package instead of ./package.json.
    }
    let entry;
    try {
      entry = workspaceRequire.resolve(name, options);
    } catch {
      const hoisted = path.resolve(desktopRoot, '../../node_modules', name);
      if (fs.existsSync(path.join(hoisted, 'package.json'))) return hoisted;
      throw new Error(`cannot resolve package directory: ${name}`);
    }
    let current = path.dirname(entry);
    while (current !== path.dirname(current)) {
      const packageJson = path.join(current, 'package.json');
      if (fs.existsSync(packageJson)) {
        const manifest = JSON.parse(fs.readFileSync(packageJson, 'utf8'));
        if (manifest.name === name) return current;
      }
      current = path.dirname(current);
    }
    throw new Error(`cannot resolve package directory: ${name}`);
  }
}

const stagedModules = path.join(temp, 'node_modules');
copyRuntimeDependencyTrees(
  [...READ_SHEET_RUNTIME_PACKAGES, 'discord.js'],
  stagedModules,
  packageDirectory,
);
prunePackagedRuntime(temp);

const stagedRequire = createRequire(path.join(temp, 'probe.cjs'));
const ExcelJS = stagedRequire('exceljs');
const JSZip = stagedRequire('jszip');
const { Client, GatewayIntentBits, EmbedBuilder } = stagedRequire('discord.js');
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
if (new EmbedBuilder().setTitle('ok').toJSON().title !== 'ok') throw Error('Discord builder');
await client.destroy();
const workbook = new ExcelJS.Workbook();
workbook.addWorksheet('Sheet1').addRow(['ok']);
const bytes = await workbook.xlsx.writeBuffer();
const zip = await JSZip.loadAsync(bytes);
process.stdout.write(zip.file('xl/workbook.xml') ? 'ok' : 'missing');
