import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

/** Inventory all source files, including adapters not executed by Cindy. A sync must expose
 * new compatibility code outside the imported closure instead of silently overlooking it. */
export function inventoryUpstream(root) {
  const files = {};
  const visit = relative => {
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const name = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) visit(name);
      else if (entry.isFile()) {
        files[name] = createHash('sha256').update(fs.readFileSync(path.join(root, name))).digest('hex');
      }
    }
  };
  visit('src');
  return files;
}
export function inventoryDelta(before, after) {
  return {
    added: Object.keys(after).filter(name => !(name in before)),
    removed: Object.keys(before).filter(name => !(name in after)),
    changed: Object.keys(after).filter(name => name in before && after[name] !== before[name]),
  };
}
