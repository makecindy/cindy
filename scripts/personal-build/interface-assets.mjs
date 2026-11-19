import fs from 'node:fs';
import path from 'node:path';
import {treeIdentity} from './runtime-store.mjs';

export function interfaceDigest(directory) {
  const root = path.join(directory, 'apps/desktop/.vite');
  // Never attest a symlink to mutable bytes outside the candidate.
  function inspect(dir) {
    if (!fs.lstatSync(dir).isDirectory()) throw Error('Expected a physical interface directory');
    for (const entry of fs.readdirSync(dir, {withFileTypes:true})) {
      if (entry.isDirectory()) inspect(path.join(dir, entry.name));
      else if (!entry.isFile()) throw Error('Unexpected interface asset: ' + entry.name);
    }
  }
  inspect(root);
  for (const entry of ['build/index.js','build/preload.js','renderer/main_window/index.html','renderer/desktop_capture/index.html']) {
    if (!fs.statSync(path.join(root, entry)).size) throw Error('Empty interface entry: ' + entry);
  }
  return treeIdentity(root);
}
export function verifyInterface(directory, digest) {
  if (interfaceDigest(directory) !== digest) throw Error('Tested interface assets changed; prepare and smoke the candidate again');
}
