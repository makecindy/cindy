import { readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { desktop, root } from './build.mjs';

export const fixturesDir = path.join(desktop, 'scripts/fixtures');

function validate(definition, file) {
  const fail = (message) => {
    throw new Error(`${path.relative(desktop, file)}: ${message}`);
  };
  if (!/^[a-z0-9-]+$/.test(definition.name ?? '')) fail('name must be kebab-case');
  if (!definition.entry) fail('entry is required');
  if (!definition.cases?.default) fail('cases.default is required');
  if (!definition.viewport?.width || !definition.viewport?.height) fail('viewport is required');
  if (!definition.real || !definition.notCovered) fail('real and notCovered describe the scope');
  for (const [name, item] of Object.entries(definition.cases))
    if (!/^[a-z0-9-]+$/.test(name) || !item.about)
      fail(`case ${name} needs a kebab name and about`);
}

/** Every `scripts/fixtures/<dir>/ui-page.mjs`; adding a page never edits a central list. */
export async function loadPages() {
  const pages = {};
  for (const entry of await readdir(fixturesDir, { withFileTypes: true })) {
    const file = path.join(fixturesDir, entry.name, 'ui-page.mjs');
    if (!entry.isDirectory() || !existsSync(file)) continue;
    const definition = (await import(pathToFileURL(file).href)).default;
    validate(definition, file);
    if (pages[definition.name]) throw new Error(`Duplicate UI page: ${definition.name}`);
    pages[definition.name] = { ...definition, dir: path.dirname(file), file };
  }
  return pages;
}

/** Re-imports a page definition after its file changed (preview). */
export async function reloadPage(definition) {
  if (definition.adhoc) return definition;
  const fresh = (await import(`${pathToFileURL(definition.file).href}?v=${Date.now()}`)).default;
  validate(fresh, definition.file);
  return { ...fresh, dir: definition.dir, file: definition.file };
}

/** Throwaway entry written by an agent: generic checks only, cases come from mountPage(). */
export function adhocPage(entry) {
  if (!existsSync(entry)) throw new Error(`--entry not found: ${entry}`);
  return {
    name: 'entry',
    entry,
    dir: path.dirname(entry),
    adhoc: true,
    viewport: { width: 1040, height: 760 },
    cases: { default: { about: 'Ad-hoc entry' } },
    real: `Everything imported by ${entry.startsWith(root + path.sep) ? path.relative(root, entry) : entry}`,
    notCovered: 'No page-specific assertions; only generic checks and screenshots',
    stubs: {},
  };
}
