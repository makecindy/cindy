#!/usr/bin/env node
/** Added-line design audit. Report first, then block only the mature colour scope.
 * Explicit refs are compared directly; --worktree includes staged, unstaged and
 * untracked source files. No shell interpolation, index writes or commits. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBareColors, maskColorComments } from './shared/hardcoded-color-match.mjs';
import { reportDesignLayers } from './shared/design-layer-report.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = (text) => createHash('sha256').update(text).digest('hex');
const EXTENSIONS = /\.(?:[cm]?[jt]sx?|css|html|md|json|svg)$/;
export function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/** Existing Mobile discipline continues independently; new diff blocking starts
 * with Desktop renderer consumers. Other sources stay visible as report/allowed. */
export function colorScope(file) {
  if (/\/(?:__tests__|__mocks__|fixtures)\/|\.(?:test|spec)\./.test(file)) return 'test';
  if (file === 'apps/desktop/src/renderer/themes/colors.ts'
    || /^apps\/desktop\/src\/renderer\/themes\/builtin\/[^/]+\.ts$/.test(file)
    || file === 'apps/mobile/src/theme/tokens.ts') return 'source';
  if (file.startsWith('apps/desktop/src/renderer/')
    && !/\/(?:assets|vendor)\//.test(file) && /\.(?:[cm]?[jt]sx?|css|html)$/.test(file)) return 'block';
  return 'report';
}

export function readExemptions(root) {
  const data = JSON.parse(fs.readFileSync(path.join(root, 'scripts/hardcoded-color-exemptions.json'), 'utf8'));
  if (!Array.isArray(data) || data.some(e => !e.glob || !e.reason || !e.owner)) {
    throw new Error('Invalid hardcoded-color-exemptions.json; expected glob/reason/owner');
  }
  for (const entry of data) {
    if (entry.matches !== undefined && !Array.isArray(entry.matches)) throw new Error(`Invalid matches: ${entry.glob}`);
    for (const rule of entry.matches ?? []) {
      if (typeof rule.value !== 'string' || typeof rule.before !== 'string' || !rule.before || !entry.reviewDate) throw new Error(`Invalid narrow exemption: ${entry.glob}`);
      if (rule.object !== undefined && !(typeof rule.object === 'string' ? rule.object
        : Array.isArray(rule.object) && rule.object.length && rule.object.every(o => typeof o === 'string' && o))) {
        throw new Error(`Invalid object binding: ${entry.glob}`);
      }
      new RegExp(rule.before);
    }
  }
  return data;
}

/** Key path of the object literals enclosing index, outermost first — e.g.
 * ['VARIANT_MAP', 'info'] for a colour inside `VARIANT_MAP = { info: { … } }`.
 * Anonymous blocks (function bodies, call arguments, array literals) add no
 * segment; string contents are skipped. Lexical, like the rest of this
 * scanner: unbalanced braces inside regex literals can only fail closed
 * (the binding stops matching and the hit is reported). */
export function objectPathAt(source, index) {
  const stack = [];
  let quote = '';
  for (let i = 0; i < index; i++) {
    const char = source[i];
    if (quote) {
      if (char === '\\') i++;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'" || char === '`') { quote = char; continue; }
    if (char === '{') {
      const head = source.slice(Math.max(0, i - 200), i);
      // `key: {` (optionally quoted), `NAME = {` and `NAME: Type = {`; the
      // type annotation may not cross statement or block boundaries, and the
      // 200-char window bounds how far back we look for the declared name.
      const prop = /["']?([A-Za-z_$][\w$]*)["']?\s*:\s*$/.exec(head);
      const decl = /([A-Za-z_$][\w$]*)\s*(?::[^;{}=]*)?=\s*$/.exec(head);
      stack.push(prop ? prop[1] : decl ? decl[1] : null);
    } else if (char === '}' && stack.length) stack.pop();
  }
  return stack.filter(Boolean);
}

export function approvedColor(file, source, hit, exemptions) {
  let enclosing; // lazy: object key path at the hit, shared by every rule below
  return exemptions.find(entry => {
    const glob = new RegExp('^' + entry.glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
    if (!glob.test(file)) return false;
    // Old broad entries are historical records, never consumer-file bypasses.
    return (entry.matches ?? []).some(rule => {
      if (hit.value.toLowerCase().replace(/\s/g, '') !== rule.value.toLowerCase().replace(/\s/g, '')) return false;
      if (!new RegExp(`(?:^|[^\\w-])(?:${rule.before})$`).test(source.slice(0, hit.index))) return false;
      if (rule.selector) {
        const open = source.lastIndexOf('{', hit.index);
        const prevClose = source.lastIndexOf('}', open);
        const normalize = value => value.replace(/'/g, '"').replace(/\s+/g, ' ').trim();
        if (normalize(source.slice(prevClose + 1, open)) !== normalize(rule.selector)) return false;
      }
      // Bind the exception to the approved object (and variant/skin): the same
      // value under the same property in any other object of the file stays a
      // violation. Without this, a new object could reuse an approved colour.
      if (rule.object) {
        enclosing ??= objectPathAt(source, hit.index).join('.');
        const objects = Array.isArray(rule.object) ? rule.object : [rule.object];
        if (!objects.includes(enclosing)) return false;
      }
      return true;
    });
  });
}

export function addedLines(diff) {
  const lines = new Set();
  let current = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('@@')) {
      const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (!match) throw new Error('Malformed diff hunk');
      current = Number(match[1]);
    } else if (current !== null && line.startsWith('+')) lines.add(current++);
    else if (current !== null && line.startsWith(' ')) current++;
  }
  return lines;
}

export function inspectFile(file, source, changed, exemptions) {
  const starts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === '\n') starts.push(i + 1);
  const locate = index => {
    let low = 0, high = starts.length;
    while (low + 1 < high) { const mid = (low + high) >> 1; if (starts[mid] <= index) low = mid; else high = mid; }
    return { line: low + 1, column: index - starts[low] + 1 };
  };
  const scope = colorScope(file);
  const clean = maskColorComments(source);
  const colors = findBareColors(source).flatMap(hit => {
    const pos = locate(hit.index);
    const end = locate(hit.end - 1).line;
    const addedLine = [...changed].filter(line => line >= pos.line && line <= end).sort((a, b) => a - b)[0];
    if (addedLine === undefined) return [];
    const candidatePos = addedLine === pos.line ? pos : { line: addedLine, column: 1 };
    const exemption = approvedColor(file, clean, hit, exemptions);
    const disposition = exemption || scope === 'source' || scope === 'test' ? 'allowed' : scope;
    return [{ file, ...candidatePos, literalStart: pos, rule: 'bare-color', value: hit.value, disposition,
      reason: exemption?.reason ?? (scope === 'source' ? 'Governed colour source; existing theme guards still apply.'
        : scope === 'test' ? 'Test/fixture colour, not a production consumer.'
        : scope === 'report' ? 'Literal colour outside the newly blocking scope; inspect its role (documentation, asset, runtime or future UI scope), not automatically a violation.'
        : 'Literal colour bypasses semantic Light/Dark theme roles (including literal fallbacks).'),
      suggestion: 'Desktop: find the matching role in themes/colors.ts and consume var(--role) / hsl(var(--role)); preserve local aliases. Mobile: use ThemeColors. If no role fits, request a design decision; do not guess a token.',
    }];
  });
  const layers = scope === 'block' ? reportDesignLayers(file, clean, changed, locate) : [];
  return [...colors, ...layers];
}

export function audit({ root = ROOT, baseRef = 'origin/main', headRef = 'HEAD', worktree = false } = {}) {
  const resolve = ref => git(root, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]).trim();
  const base = resolve(baseRef), head = resolve(headRef);
  const exemptions = readExemptions(root);
  const range = worktree ? [base] : [base, head];
  const diffArgs = ['diff', '--no-ext-diff', '--no-textconv', '--no-renames'];
  const tracked = git(root, [...diffArgs, '--name-only', '-z', ...range, '--']).split('\0').filter(Boolean);
  const untracked = worktree ? git(root, ['ls-files', '--others', '--exclude-standard', '-z', '--', 'apps', 'packages', 'scripts', 'docs', '.github']).split('\0').filter(Boolean) : [];
  const files = [...new Set([...tracked, ...untracked])].filter(f => EXTENSIONS.test(f)).sort();
  const findings = [], sources = [];
  for (const file of files) {
    let source;
    if (worktree) {
      const absolute = path.join(root, ...file.split('/'));
      if (!fs.existsSync(absolute)) continue; // deleted file
      if (!fs.lstatSync(absolute).isFile()) throw new Error(`Not a regular source file: ${file}`);
      source = fs.readFileSync(absolute, 'utf8');
    } else {
      const entry = git(root, ['ls-tree', head, '--', file]);
      if (!entry) continue;
      if (!/^100(?:644|755) blob /.test(entry)) continue; // symlink/gitlink is not source
      source = git(root, ['show', `${head}:${file}`]);
    }
    const changed = untracked.includes(file) ? new Set(source.split('\n').map((_, i) => i + 1))
      : addedLines(git(root, [...diffArgs, '--unified=0', ...range, '--', file]));
    sources.push({ file, sha256: hash(source), addedLines: [...changed] });
    try { findings.push(...inspectFile(file, source, changed, exemptions)); }
    catch (error) { throw new Error(`${file}: ${error.message}`); }
  }
  const scripts = ['scripts/hardcoded-color-audit.mjs', 'scripts/shared/hardcoded-color-match.mjs',
    'scripts/shared/design-layer-report.mjs', 'scripts/hardcoded-color-exemptions.json'];
  const scriptHashes = Object.fromEntries(scripts.map(f => [f, hash(fs.readFileSync(path.join(f.endsWith('.json') ? root : ROOT, f)))]));
  const colors = findings.filter(f => f.rule === 'bare-color');
  return { schemaVersion: 1, base, head, candidate: worktree ? 'worktree (staged + unstaged + untracked)' : 'commit',
    scriptHashes, candidateHash: hash(JSON.stringify(sources)), sources,
    counts: { raw: colors.length, allowed: colors.filter(f => f.disposition === 'allowed').length,
      unexpected: colors.filter(f => f.disposition === 'block').length,
      report: findings.filter(f => f.disposition === 'report').length }, findings };
}

export function main(args = process.argv.slice(2)) {
  const options = {};
  let report = false, json = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--report') report = true;
    else if (args[i] === '--json') json = true;
    else if (args[i] === '--worktree') options.worktree = true;
    else if (['--base-ref', '--head-ref'].includes(args[i])) {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing value for ${args[i]}`);
      options[args[i] === '--base-ref' ? 'baseRef' : 'headRef'] = args[++i];
    } else throw new Error(`Unknown argument: ${args[i]}`);
  }
  if (options.worktree && options.headRef) throw new Error('--worktree and --head-ref are mutually exclusive');
  const result = audit(options);
  if (json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`BASE ${result.base} HEAD ${result.head} ${result.candidate}\n${JSON.stringify(result.counts)}`);
    for (const f of result.findings.filter(f => f.disposition !== 'allowed')) {
      console.log(`${f.file}:${f.line}:${f.column} [${f.disposition}/${f.rule}] ${f.value}\n  ${f.reason}\n  ${f.suggestion}`);
    }
  }
  return !report && result.counts.unexpected > 0 ? 1 : 0;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(); }
  catch (error) { console.error(`[design-audit] ${error.message}`); process.exitCode = 2; }
}
