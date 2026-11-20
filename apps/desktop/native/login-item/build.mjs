import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMacAddon } from '../build-mac-addon.mjs';

const source = path.dirname(fileURLToPath(import.meta.url));
export function buildLoginItem(output, arch = process.arch) {
  buildMacAddon(path.join(source, 'login-item.mm'), output, arch, ['Foundation', 'ServiceManagement']);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildLoginItem(
    process.argv[2] || path.join(source, '../../resources/tools/login-item/cindy-login-item.node'),
    process.argv[3],
  );
}
