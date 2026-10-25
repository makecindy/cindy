import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimePackages, imRuntimePackages } from './runtime-externals.mjs';
import { readCindyBuildVersion } from './build-version.mjs';
import { desktopClientBuildEnv } from '../../../scripts/shared/client-endpoint-build-env.mjs';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../desktop');

/** Same bundle for source acceptance and the signed Forge package. */
export async function buildDesktopPlatformMain(outfile, write = true) {
  const environment = desktopClientBuildEnv({ allowEnvOverride: false });
  const result = await build({
    entryPoints: [path.join(desktop, 'src/main/terminal-platform-entry.ts')], outfile, write,
    bundle: true, platform: 'node', target: 'node22', format: 'esm', sourcemap: true, metafile: true,
    loader: { '.md': 'text', '.png': 'dataurl', '.webp': 'dataurl' },
    external: ['electron', 'loudness', ...runtimePackages, ...imRuntimePackages, 'react/jsx-runtime'],
    define: {
      __CINDY_APP_VERSION__: JSON.stringify(readCindyBuildVersion()),
      __CINDY_SOURCE_NODE_BINARY__: JSON.stringify(process.execPath),
      __CINDY_PLATFORM_REGION__: JSON.stringify(environment.VITE_CINDY_AUTH_REGION || 'global'),
      'import.meta.env': JSON.stringify(environment),
      DESKTOP_CAPTURE_VITE_NAME: JSON.stringify('desktop_capture'),
      DESKTOP_CAPTURE_VITE_DEV_SERVER_URL: 'undefined',
    },
    banner: { js: 'import { createRequire as __createRequire } from "node:module"; import { fileURLToPath as __fileURLToPath } from "node:url"; import { dirname as __dirnameOf } from "node:path"; const require = __createRequire(import.meta.url); const __dirname = __dirnameOf(__fileURLToPath(import.meta.url));' },
  });
  for (const input of Object.keys(result.metafile.inputs)) {
    if (/apps\/desktop\/src\/main\/(?:bootstrap-electron|authManager|deepLink)\.ts$/.test(input.replaceAll('\\','/')))
      throw new Error(`Unexpected application bootstrap dependency: ${input}`);
  }
  return result;
}
