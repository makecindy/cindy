import {execFileSync} from 'node:child_process';
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, copyFile, cp, readFile, writeFile } from 'node:fs/promises';
import { buildCli } from './build-cli.mjs';
import { readCindyBuildVersion, readCindyBuildRegion } from './build-version.mjs';

const appDir=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const version = readCindyBuildVersion();
const region = readCindyBuildRegion();
await mkdir(path.join(appDir,'dist'),{recursive:true});
// Ship the same remote daemons and compatibility proxy as Desktop.
for(const [name,bundle] of [['maker-pi-manager','pi-manager.mjs'],['maker-cc-manager','cc-mgr.mjs'],['anthropic-compat-proxy','proxy.mjs']]) {
  const directory=path.join(appDir,'../../packages',name);
  execFileSync(process.execPath,['build.mjs'],{cwd:directory,stdio:'inherit'});
  await copyFile(path.join(directory,'dist',bundle),path.join(appDir,'dist',bundle));
}

// The SSH daemon is the same source shipped with Desktop. Keep its inputs
// normalized so bundle versions remain identical on Windows and POSIX hosts.
await build({
  entryPoints:[path.join(appDir,'../../packages/remote-file-service/src/bin/file-service.ts')],
  outfile:path.join(appDir,'dist/file-service.mjs'),platform:'node',target:'node20',format:'esm',bundle:true,
  banner:{js:'#!/usr/bin/env node'},legalComments:'none',
  plugins:[{name:'normalize-eol-lf',setup(builder){builder.onLoad({filter:/\.(ts|js|mjs|cjs|json)$/},async args=>({
    contents:(await readFile(args.path,'utf8')).replace(/\r\n/g,'\n'),loader:args.path.endsWith('.ts')?'ts':args.path.endsWith('.json')?'json':'js',
  }));}}],
});
await buildCli();

// The native plugin worker keeps the same published bootstrap ABI as Desktop.
await build({ entryPoints:[path.join(appDir,'../../packages/plugin-runtime/src/nativeWorkerEntry.ts')], outfile:path.join(appDir,'dist/plugin-node-worker.cjs'), platform:'node', target:'node22', format:'cjs', bundle:true, sourcemap:true });
await build({ entryPoints:[path.join(appDir,'../../packages/plugin-runtime/src/nativeSnapshotWorker.ts')], outfile:path.join(appDir,'dist/plugin-snapshot-worker.cjs'), platform:'node', target:'node22', format:'cjs', bundle:true, sourcemap:true });
await build({ entryPoints:[path.join(appDir,'../../packages/plugin-runtime/src/library/libraryDbWorker.ts')], outfile:path.join(appDir,'dist/plugin-library-worker.mjs'), platform:'node', target:'node22', format:'esm', bundle:true, sourcemap:true, external:['better-sqlite3'] });
await build({ entryPoints:[path.join(appDir,'../../packages/plugin-runtime/src/forgeScaffoldWorkerProcess.ts')], outfile:path.join(appDir,'dist/plugin-scaffold-worker.cjs'), platform:'node', target:'node22', format:'cjs', bundle:true, sourcemap:true });
await build({ entryPoints:[path.join(appDir,'src/service-supervisor-entry.ts')], outfile:path.join(appDir,'dist/service-supervisor.cjs'), platform:'node', target:'node22', format:'cjs', bundle:true, sourcemap:true });
await build({ entryPoints:[path.join(appDir,'src/pi-subagent-process.ts')], outfile:path.join(appDir,'dist/pi-subagent-process.cjs'), platform:'node', target:'node22', format:'cjs', bundle:true, sourcemap:true });
await build({ entryPoints:[path.join(appDir,'src/docs-output-process.ts')], outfile:path.join(appDir,'dist/docs-output-process.cjs'), platform:'node', target:'node22', format:'cjs', bundle:true, sourcemap:true });
await build({ entryPoints:[path.join(appDir,'src/docs-pdf-process.ts')], outfile:path.join(appDir,'dist/docs-pdf-process.mjs'), platform:'node', target:'node22', format:'esm', bundle:true, sourcemap:true, external:['@napi-rs/canvas','pdfjs-dist'] });

await build({ entryPoints:[path.join(appDir,'src/worktrees/recovery-worker.ts')], outfile:path.join(appDir,'dist/worktree-recovery-worker.cjs'), platform:'node', target:'node22', format:'cjs', bundle:true, sourcemap:true });

// Both hosts use the original database worker and migration resources.
for (const [entry, output] of [
  ['../../packages/runtime-db/src/worker/dbWorker.ts', 'database-worker.mjs'],
  ['src/database-maintenance-process.ts', 'database-maintenance-process.mjs'],
]) {
  await build({ entryPoints: [path.join(appDir, entry)], outfile: path.join(appDir, 'dist', output), platform: 'node', target: 'node22', format: 'esm', bundle: true, sourcemap: true, external: ['better-sqlite3'], banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' } });
}
await cp(path.join(appDir, '../desktop/drizzle'), path.join(appDir, 'dist/drizzle'), {
  recursive: true, filter: source => !/\d{4}_snapshot\.json$/.test(source),
});
await cp(path.join(appDir, '../desktop/native/sqlite-vec', `${process.platform}-${process.arch}`), path.join(appDir, 'dist/sqlite-vec'), { recursive: true });
await copyFile(path.join(appDir, '../desktop/native/sqlite-vec/LICENSE'), path.join(appDir, 'dist/sqlite-vec/LICENSE'));

await copyFile(path.join(appDir,'../../packages/plugin-runtime/src/mailComposeRuntime.js'),path.join(appDir,'dist/plugin-mail-runtime.js'));
// Embed the exact authoring references, in the same order as Desktop's view.
const guideSource=path.join(appDir,'../desktop/src/main/cindy-brain/forgeGuide.ts');
const guide=await readFile(guideSource,'utf8');
const references=[...guide.matchAll(/import \w+ from '([^']+\.md)\?raw';/g)].map(match=>path.resolve(path.dirname(guideSource),match[1]));
if(!references.length)throw new Error('PLUGIN_AUTHORING_GUIDE_MISSING');
await writeFile(path.join(appDir,'dist/plugin-forge-guide.md'),(await Promise.all(references.map(file=>readFile(file,'utf8')))).join('\n\n'));
await writeFile(path.join(appDir, 'dist/build-info.json'), JSON.stringify({ version, region }) + '\n');

await mkdir(path.join(appDir,'dist/resources'),{recursive:true});
await copyFile(path.join(appDir,'../desktop/resources/teammate-portrait-gallery.png'),path.join(appDir,'dist/resources/teammate-portrait-gallery.png'));

for (const directory of ['companion-preset-avatars', 'legacy-teammate-avatars']) {
  await cp(path.join(appDir, '../desktop/resources', directory), path.join(appDir, 'dist/resources', directory), { recursive: true });
}

await build({entryPoints:[path.join(appDir,'../desktop/src/main/im/wechat/silkWorker.ts')],outfile:path.join(appDir,'dist/wechat-silk-worker.cjs'),platform:'node',target:'node22',format:'cjs',bundle:true,external:['silk-wasm']});
