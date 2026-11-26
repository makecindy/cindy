import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMacAddon } from '../build-mac-addon.mjs';

const source = path.dirname(fileURLToPath(import.meta.url));
export function buildTrackpad(output, arch = process.arch) {
  buildMacAddon(path.join(source, 'trackpad.mm'), output, arch, ['Cocoa']);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildTrackpad(
    process.argv[2] || path.join(source, '../../resources/tools/trackpad/cindy-trackpad.node'),
    process.argv[3],
  );
}
