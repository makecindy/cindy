import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMacAddon } from '../build-mac-addon.mjs';

const source = path.dirname(fileURLToPath(import.meta.url));
export function buildPluginOpenPanel(output, arch = process.arch) {
  buildMacAddon(path.join(source, 'open-panel.mm'), output, arch, ['Cocoa']);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildPluginOpenPanel(process.argv[2], process.argv[3]);
}
