// Overlays add imports after a module's own imports, never before them. The main bundle runs
// modules in import order: an import placed first loads its whole graph ahead of the module's
// own imports, and a module in an import cycle can then read a binding before it is initialized.
import assert from 'node:assert/strict';
import ts from 'typescript';

function moduleRequests(code, file) {
  const kind = file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, kind);
  return source.statements.filter(node => ts.isImportDeclaration(node)
    || (ts.isExportDeclaration(node) && node.moduleSpecifier)
    || (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)));
}

/** Insert import lines right after the module's last import or re-export. */
export function addImports(code, file, lines) {
  const own = moduleRequests(code, file);
  const text = lines.join('\n');
  if (!own.length) return `${text}\n${code}`;
  const end = own[own.length - 1].end;
  return `${code.slice(0, end)}\n${text}${code.slice(end)}`;
}

/** The module's own imports must still come first, in their order. */
export function assertImportOrderKept(before, after, file) {
  const specifiers = code => moduleRequests(code, file)
    .map(node => (node.moduleSpecifier ?? node.moduleReference.expression).text);
  const original = specifiers(before);
  assert.deepEqual(specifiers(after).slice(0, original.length), original, `Cloud overlay changed the import order of ${file}`);
}
