export type DtcgType = 'color';

/**
 * 标准 DTCG 颜色对象值（W3C DTCG 规范 / Terrazzo 2.7.1 均支持）。
 * HSL triplet（如 `60 12.5% 97%`）表示为 `{"colorSpace":"hsl","components":[60,12.5,97]}`；
 * hex / rgba 表示为 srgb 分量 + 可选 alpha。不再是自造的 `$type: "other"` 字符串。
 */
export interface DtcgColorObject {
  colorSpace: 'srgb' | 'hsl';
  components: number[];
  alpha?: number;
}

export type DtcgColorValue = string | DtcgColorObject;

export interface DtcgValueNode {
  $type: DtcgType;
  $value: DtcgColorValue;
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
  const valueIsString = typeof record.$value === 'string';
  const valueIsColorObject =
    !!record.$value &&
    typeof record.$value === 'object' &&
    !Array.isArray(record.$value);
  return (
    (valueIsString || valueIsColorObject) && typeof record.$type === 'string'
  );
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

const TRIPLET_COLOR_RE =
  /^(-?\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?)%$/;
const HEX6_RE = /^#([0-9a-fA-F]{6})$/;
const HEX8_RE = /^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})$/;
const RGBA_RE = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/;
const RGB_RE = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)$/;

function roundComponent(value: number): number {
  // 6 位精度：覆盖快照里 63.92%（0.6392）等 2 位小数百分比且往返无损。
  return Math.round(value * 1e6) / 1e6;
}

/**
 * 把 DS-2b 冻结快照的原始色值字符串转成标准 DTCG 颜色对象。
 *
 * HSL triplet（`60 12.5% 97%`）→ `{"colorSpace":"hsl","components":[60,12.5,97]}`；
 * hex / rgba / transparent → `{"colorSpace":"srgb","components":[r,g,b](,"alpha")}`。
 * 通道归一到 [0,1]（srgb），HSL 分量保持人读数值（h∈[0,360)，s/l∈[0,100]）。
 * 这是对 Terrazzo 2.7.1（治理合同 §5 锁定版本）实测过的表示：
 * 裸 triplet 字符串会被解析成黑色，`$type: "other"` 会被 CSS 插件静默丢弃。
 */
export function toDtcgColorObject(value: string): DtcgColorObject {
  const text = value.trim();

  const triplet = TRIPLET_COLOR_RE.exec(text);
  if (triplet) {
    return {
      colorSpace: 'hsl',
      components: [Number(triplet[1]), Number(triplet[2]), Number(triplet[3])],
    };
  }

  if (text === 'transparent') {
    return { colorSpace: 'srgb', components: [0, 0, 0], alpha: 0 };
  }

  const hex6 = HEX6_RE.exec(text);
  if (hex6) {
    const hex = hex6[1];
    return {
      colorSpace: 'srgb',
      components: [
        roundComponent(Number.parseInt(hex.slice(0, 2), 16) / 255),
        roundComponent(Number.parseInt(hex.slice(2, 4), 16) / 255),
        roundComponent(Number.parseInt(hex.slice(4, 6), 16) / 255),
      ],
    };
  }

  const hex8 = HEX8_RE.exec(text);
  if (hex8) {
    const hex = hex8[1];
    return {
      colorSpace: 'srgb',
      components: [
        roundComponent(Number.parseInt(hex.slice(0, 2), 16) / 255),
        roundComponent(Number.parseInt(hex.slice(2, 4), 16) / 255),
        roundComponent(Number.parseInt(hex.slice(4, 6), 16) / 255),
      ],
      alpha: roundComponent(Number.parseInt(hex8[2], 16) / 255),
    };
  }

  const rgba = RGBA_RE.exec(text);
  if (rgba) {
    const components = [
      roundComponent(Number(rgba[1]) / 255),
      roundComponent(Number(rgba[2]) / 255),
      roundComponent(Number(rgba[3]) / 255),
    ];
    const alpha = rgba[4] != null ? Number(rgba[4]) : undefined;
    return alpha != null
      ? { colorSpace: 'srgb', components, alpha }
      : { colorSpace: 'srgb', components };
  }

  const rgb = RGB_RE.exec(text);
  if (rgb) {
    return {
      colorSpace: 'srgb',
      components: [
        roundComponent(Number(rgb[1]) / 255),
        roundComponent(Number(rgb[2]) / 255),
        roundComponent(Number(rgb[3]) / 255),
      ],
    };
  }

  throw new Error(`无法把快照色值转成标准 DTCG 颜色对象: ${value}`);
}

/**
 * 把 DTCG 颜色对象还原成快照原始字符串形态（逐值一致守卫用）。
 * 与 `toDtcgColorObject` 互逆；hsl 分量按快照的整数/小数原样还原。
 */
export function dtcgColorObjectToString(color: DtcgColorObject): string {
  if (color.colorSpace === 'hsl') {
    const [h, s, l] = color.components;
    return `${h} ${s}% ${l}%`;
  }
  const [r, g, b] = color.components;
  const to255 = (v: number) => Math.round(v * 255);
  const alpha = color.alpha;
  if (alpha === 0) {
    // 快照里全透明写作 CSS 关键字 transparent，不是 rgba(0,0,0,0)。
    return 'transparent';
  }
  if (alpha != null && alpha < 1) {
    return `rgba(${to255(r)}, ${to255(g)}, ${to255(b)}, ${alpha})`;
  }
  const hex = (v: number) => to255(v).toString(16).padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}`;
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
