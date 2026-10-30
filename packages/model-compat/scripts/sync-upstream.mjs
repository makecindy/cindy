#!/usr/bin/env node
/** Reproduce a reviewed OpenCodex port without executing any upstream code.
 * Usage: node scripts/sync-upstream.mjs --source /checkout [--update --commit <full-sha>]
 * Default verifies both the local port and pinned source. Updates apply the reviewed patch
 * in an isolated temporary directory before writing any tracked target.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';
import { inventoryUpstream, inventoryDelta } from './upstream-inventory.mjs';
import { extractProviderProfiles } from './provider-profiles.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const value = flag => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1]; };
const source = value('--source');
const update = args.includes('--update');
const commit = value('--commit');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const manifest = JSON.parse(await fs.readFile(path.join(root, 'UPSTREAM.json'), 'utf8'));
const files = [...manifest.files, ...manifest.tests];
if (hash(await fs.readFile(path.join(root, 'src/upstream-profiles.json'))) !== manifest.profilesSha256) throw new Error('Local provider profile data changed; regenerate/review before syncing.');
for (const entry of files) {
  const bytes = await fs.readFile(path.join(root, entry.target));
  if (hash(bytes) !== entry.portedSha256) throw new Error(`Local port changed: ${entry.target}; record/review the patch before syncing.`);
}
if (!source) {
  if (update) throw new Error('--update requires --source and --commit');
  console.log(`Verified ${files.length} ported files at ${manifest.commit}.`);
  process.exit(0);
}
const sourceRoot = await fs.realpath(source);
if (update) {
  if (!/^[a-f0-9]{40}$/.test(commit ?? '')) throw new Error('Update requires a full --commit SHA.');
  const head = execFileSync('git', ['-C', sourceRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (head !== commit) throw new Error('Source checkout does not match --commit.');
  if (execFileSync('git', ['-C', sourceRoot, 'status', '--porcelain'], { encoding: 'utf8' }).trim()) throw new Error('Source checkout must be clean.');
}
const inventory = inventoryUpstream(sourceRoot);
const previousInventory = JSON.parse(await fs.readFile(path.join(root, 'upstream-inventory.json'), 'utf8'));
const changes = inventoryDelta(previousInventory, inventory);
if (!update && Object.values(changes).some(items => items.length)) throw new Error('Pinned upstream inventory changed.');
const license = await fs.readFile(path.join(sourceRoot, 'LICENSE'));
if (!update && !license.equals(await fs.readFile(path.join(root, 'LICENSE.opencodex')))) throw new Error('Pinned upstream license changed.');
const extracted = extractProviderProfiles(sourceRoot);
const profilesText = JSON.stringify(extracted.profiles, null, 2) + '\n';
if (!update && profilesText !== await fs.readFile(path.join(root, 'src/upstream-profiles.json'), 'utf8')) throw new Error('Provider profiles are not reproducible from the pinned registry.');
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-model-compat-sync-'));
try {
  const originals = new Map();
  for (const entry of files) {
    const bytes = await fs.readFile(path.join(sourceRoot, entry.source));
    if (!update && hash(bytes) !== entry.upstreamSha256) throw new Error(`Pinned upstream file differs: ${entry.source}`);
    originals.set(entry.source, bytes);
    const dest = path.join(scratch, entry.source);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, bytes);
  }
  const patch = await fs.readFile(path.join(root, 'upstream.patch'));
  execFileSync('git', ['apply', '--check', '-'], { cwd: scratch, input: patch });
  execFileSync('git', ['apply', '-'], { cwd: scratch, input: patch });
  const outputs = new Map();
  for (const entry of manifest.files) {
    let bytes = await fs.readFile(path.join(scratch, entry.source));
    if (entry.extractSymbols) {
      const sf = ts.createSourceFile(entry.source, bytes.toString('utf8'), ts.ScriptTarget.Latest, true);
      const declarations = sf.statements.filter(node => entry.extractSymbols.includes(node.name?.text ?? (ts.isVariableStatement(node) ? node.declarationList.declarations[0]?.name?.getText(sf) : undefined)));
      if (declarations.length !== entry.extractSymbols.length) throw new Error('Upstream helper extraction changed: ' + entry.source);
      bytes = Buffer.from(entry.extractionPrefix + declarations.map(node =>
        (node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) ? '' : 'export ') + node.getText(sf)).join('\n\n') + '\n');
    }
    outputs.set(entry.target, bytes);
  }
  for (const entry of manifest.tests) {
    let text = originals.get(entry.source).toString('utf8');
    const sf = ts.createSourceFile(entry.source, text, ts.ScriptTarget.Latest, true);
    const edits = [];
    for (const node of sf.statements) {
      if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) continue;
      const spec = node.moduleSpecifier.text;
      let replacement = spec;
      if (spec === 'bun:test') replacement = 'vitest';
      else if (spec.startsWith('.')) {
        const imported = path.posix.normalize(path.posix.join(path.posix.dirname(entry.source), spec)).replace(/\.ts$/, '') + '.ts';
        const mapped = manifest.files.find(candidate => candidate.source === imported);
        if (!mapped) throw new Error(`New upstream test dependency needs review: ${imported}`);
        replacement = path.relative(path.dirname(path.join(root, entry.target)), path.join(root, mapped.target)).split(path.sep).join('/').replace(/\.ts$/, '');
      }
      edits.push([node.moduleSpecifier.getStart(sf), node.moduleSpecifier.end, JSON.stringify(replacement)]);
    }
    for (const [start, end, replacement] of edits.reverse()) text = text.slice(0, start) + replacement + text.slice(end);
    const result = ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
    outputs.set(entry.target, Buffer.from(result));
  }
  if (!update) {
    for (const entry of files) if (hash(outputs.get(entry.target)) !== entry.portedSha256) throw new Error(`Port is not reproducible: ${entry.target}`);
    console.log(`Verified pinned source, patch, and ${files.length} reproduced files.`);
  } else {
    // All patch applications and test dependency checks have passed before the first source write.
    for (const entry of files) {
      const bytes = outputs.get(entry.target);
      await fs.writeFile(path.join(root, entry.target), bytes);
      entry.upstreamSha256 = hash(originals.get(entry.source));
      entry.portedSha256 = hash(bytes);
    }
    await fs.writeFile(path.join(root, 'src/upstream-profiles.json'), profilesText);
    await fs.writeFile(path.join(root, 'LICENSE.opencodex'), license);
    await fs.writeFile(path.join(root, 'upstream-inventory.json'), JSON.stringify(inventory, null, 2) + '\n');
    await fs.writeFile(path.join(root, 'UPSTREAM-CHANGES.json'), JSON.stringify({ from: manifest.commit, to: commit, ...changes }, null, 2) + '\n');
    manifest.registrySources = extracted.sources;
    manifest.profilesSha256 = hash(profilesText);
    manifest.commit = commit;
    await fs.writeFile(path.join(root, 'UPSTREAM.json'), JSON.stringify(manifest, null, 2) + '\n');
    console.log('Updated modules and provider declarations. Review UPSTREAM-CHANGES.json, including new/unported modules, then run conformance and consumer tests before committing.');
  }
} finally {
  await fs.rm(scratch, { recursive: true, force: true });
}
