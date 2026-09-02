export type DtcgType = 'color' | 'other';

export interface DtcgValueNode {
  $type: DtcgType;
  $value: string;
}

export interface DtcgAliasNode {
  $type: DtcgType;
  $value: `{${string}}`;
}

export type DtcgLeaf = DtcgValueNode | DtcgAliasNode;

export interface DtcgGroup {
  [key: string]: DtcgNode;
}

export type DtcgNode = DtcgLeaf | DtcgGroup;

export interface DtcgFile {
  $description?: string;
  [key: string]: DtcgNode | string | undefined;
}

export const TOKEN_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;
const ALIAS_RE = /^\{([A-Za-z0-9][A-Za-z0-9._-]*)\}$/;

export function isDtcgLeaf(node: unknown): node is DtcgLeaf {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return false;
  const record = node as Record<string, unknown>;
  return typeof record.$value === 'string' && typeof record.$type === 'string';
}

export function parseAliasPath(value: string): string[] | null {
  const match = ALIAS_RE.exec(value);
  if (!match) return null;
  return match[1].split('.');
}

export function aliasValue(path: string[]): `{${string}}` {
  return `{${path.join('.')}}`;
}

export function walkLeaves(
  node: DtcgNode,
  visit: (path: string[], leaf: DtcgLeaf) => void,
  path: string[] = [],
): void {
  if (isDtcgLeaf(node)) {
    visit(path, node);
    return;
  }
  for (const [key, child] of Object.entries(node)) {
    if (key.startsWith('$')) continue;
    walkLeaves(child, visit, [...path, key]);
  }
}

export function lookupPath(root: DtcgGroup, path: string[]): DtcgNode | undefined {
  let current: DtcgNode | undefined = root;
  for (const segment of path) {
    if (!current || isDtcgLeaf(current) || typeof current !== 'object') return undefined;
    current = current[segment];
  }
  return current;
}

export function assertTokenName(name: string): void {
  if (!TOKEN_NAME_RE.test(name)) {
    throw new Error(`非法 DTCG token 名: ${name}`);
  }
}

export function collectLeaves(file: DtcgFile): Array<{ path: string[]; leaf: DtcgLeaf }> {
  const leaves: Array<{ path: string[]; leaf: DtcgLeaf }> = [];
  for (const [key, value] of Object.entries(file)) {
    if (key.startsWith('$') || value == null || typeof value === 'string') continue;
    walkLeaves(value, (path, leaf) => leaves.push({ path: [key, ...path], leaf }));
  }
  return leaves;
}

export function resolveAlias(
  files: Record<string, DtcgFile>,
  fromFile: string,
  value: string,
): { file: string; path: string[]; leaf: DtcgLeaf } | null {
  const path = parseAliasPath(value);
  if (!path) return null;
  const file = files[fromFile];
  if (!file) return null;
  const local = lookupPath(file as DtcgGroup, path);
  if (isDtcgLeaf(local)) {
    return { file: fromFile, path, leaf: local };
  }
  for (const [name, other] of Object.entries(files)) {
    if (name === fromFile) continue;
    const found = lookupPath(other as DtcgGroup, path);
    if (isDtcgLeaf(found)) {
      return { file: name, path, leaf: found };
    }
  }
  return null;
}
