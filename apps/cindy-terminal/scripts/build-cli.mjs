import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdir, unlink } from 'node:fs/promises';
import { runtimePackages, imRuntimePackages } from './runtime-externals.mjs';
import { readCindyBuildVersion, readCindyBuildRegion } from './build-version.mjs';

const appDir=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');

// Shared by packaging and the loading-boundary verification: test the actual
// distribution settings, including the external React/Ink runtime packages.
export async function buildCli({write=true}={}) {
  // Keep old content-hashed chunks out of subsequent distribution archives.
  if(write)for(const file of await readdir(path.join(appDir,'dist'))){
    if(/^chunk-.*\.js(?:\.map)?$/.test(file))await unlink(path.join(appDir,'dist',file));
  }
  return build({
    entryPoints:[path.join(appDir,'src/cli.tsx')],outdir:path.join(appDir,'dist'),
    splitting:true,chunkNames:'chunk-[name]-[hash]',
    platform:'node',target:'node22',format:'esm',bundle:true,sourcemap:true,
    define:{__CINDY_APP_VERSION__:JSON.stringify(readCindyBuildVersion()),__CINDY_APP_REGION__:JSON.stringify(readCindyBuildRegion())},
    loader:{'.md':'text'},external:[...runtimePackages,...imRuntimePackages,'react/jsx-runtime'],
    banner:{js:'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);'},
    metafile:true,write,
  });
}
