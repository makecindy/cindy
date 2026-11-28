import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { addImports, assertImportOrderKept } from './overlay-imports.mjs';
import { transformCloudSource, targets as guidanceTargets } from './runtime-guidance/overlay.mjs';
import { transformCloudWindowSource, targets as windowTargets } from './runtime-window-controls/overlay.mjs';
import { transformCloudActivitySource, targets as activityTargets } from './runtime-activity/overlay.mjs';
import { transformMaintenanceSource, targets as maintenanceTargets } from './runtime-maintenance/overlay.mjs';
import { transformCloudIdentitySource, targets as identityTargets } from './runtime-identity/overlay.mjs';
import { transformCloudUpdateSource, targets as updateTargets } from './runtime-updates/overlay.mjs';

const source = "import { a } from './a.js';\nexport { b } from './b.js';\nconst value = a();\n";

test('added imports follow the module\'s own imports and re-exports', () => {
  const added = addImports(source, 'x.ts', ["import { c } from './c.js';"]);
  assert.equal(added, "import { a } from './a.js';\nexport { b } from './b.js';\nimport { c } from './c.js';\nconst value = a();\n");
  assertImportOrderKept(source, added, 'x.ts');
  assert.equal(addImports('const value = 1;\n', 'x.ts', ["import { c } from './c.js';"]), "import { c } from './c.js';\nconst value = 1;\n");
});

test('an import placed before the module\'s own imports is rejected', () => {
  assert.throws(() => assertImportOrderKept(source, `import { c } from './c.js';\n${source}`, 'x.ts'), /changed the import order of x\.ts/);
  assert.throws(() => assertImportOrderKept(source, source.replace("export { b } from './b.js';\n", ''), 'x.ts'), /import order/);
});

// The overlays in the order stage-cloud-overlays.mjs applies them.
const overlays = [[guidanceTargets, transformCloudSource], [windowTargets, transformCloudWindowSource],
  [updateTargets, transformCloudUpdateSource], [identityTargets, transformCloudIdentitySource],
  [activityTargets, transformCloudActivitySource], [maintenanceTargets, transformMaintenanceSource]];
const client = process.env.CINDY_TEST_CLIENT_SOURCE;
test('real sources keep their own imports first after every overlay', { skip: !client }, () => {
  const files = new Map();
  for (const [targets, transform] of overlays) {
    for (const relative of targets) {
      const before = files.get(relative) ?? fs.readFileSync(path.join(client, relative), 'utf8');
      const after = transform(before, relative);
      assertImportOrderKept(before, after, relative);
      files.set(relative, after);
    }
  }
  assert.ok(files.size > 10);
});
