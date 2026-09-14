import ts from "typescript";

// Read only literal data from Pi's generated provider shards. Never execute the binary,
// its application code, a model expression, or the user's Pi configuration.
function literal(node) {
  if (ts.isStringLiteral(node) || ts.isNumericLiteral(node)) {
    return ts.isNumericLiteral(node) ? Number(node.text) : node.text;
  }
  if (
    ts.isPrefixUnaryExpression(node) &&
    node.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(node.operand)
  )
    return -Number(node.operand.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isArrayLiteralExpression(node)) return node.elements.map(literal);
  if (ts.isObjectLiteralExpression(node))
    return Object.fromEntries(
      node.properties.map((p) => {
        if (
          !ts.isPropertyAssignment(p) ||
          !p.name ||
          ts.isComputedPropertyName(p.name)
        ) {
          throw new Error("Pi catalog contains a non-literal property");
        }
        return [p.name.text, literal(p.initializer)];
      }),
    );
  throw new Error(
    `Pi catalog contains a non-literal value: ${ts.SyntaxKind[node.kind]} ${node.getText().slice(0, 100)}`,
  );
}

export function readBundledCatalog(source) {
  const result = {};
  const marker =
    /\/\/ [^\n]*ai\/src\/providers\/data\/([^/\n]+)\.json\r?\nvar [\w$]+ = /g;
  for (const match of source.matchAll(marker)) {
    // Pi's index is not a provider and has no /providers/.manifest endpoint.
    if (match[1] === '.manifest') continue;
    const start = match.index + match[0].length;
    const scanner = ts.createScanner(
      ts.ScriptTarget.Latest,
      true,
      ts.LanguageVariant.Standard,
      source.slice(start),
    );
    let depth = 0;
    let end = 0;
    for (
      let token = scanner.scan();
      token !== ts.SyntaxKind.EndOfFileToken;
      token = scanner.scan()
    ) {
      if (token === ts.SyntaxKind.OpenBraceToken) depth++;
      if (token === ts.SyntaxKind.CloseBraceToken && --depth === 0) {
        end = scanner.getTextPos();
        break;
      }
    }
    if (!end) throw new Error(`Incomplete Pi catalog shard: ${match[1]}`);
    const file = ts.createSourceFile(
      "catalog.ts",
      `const data = ${source.slice(start, start + end)};`,
      ts.ScriptTarget.Latest,
      true,
    );
    const data = literal(
      file.statements[0].declarationList.declarations[0].initializer,
    );
    const rows = Object.values(data).flatMap((group) => Object.values(group));
    result[match[1]] = rows.filter(
      (row) => row.contextWindow > 0 && row.provider === match[1],
    );
  }
  if (!Object.keys(result).length)
    throw new Error(
      "No generated Pi provider shards found; supply --input from the upstream generator instead",
    );
  return result;
}
