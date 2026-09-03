import {
  aliasValue,
  assertTokenName,
  dtcgColorObjectToString,
  toDtcgColorObject,
  type DtcgColorObject,
  type DtcgFile,
} from './dtcg.ts';
import { SEMANTIC_ROLES } from './semantic-roles.ts';
import type { SnapshotColor } from './snapshot.ts';

export interface BuiltLayers {
  reference: DtcgFile;
  semantic: DtcgFile;
}

function refTokenName(value: string, used: Map<string, string>): string {
  const existing = used.get(value);
  if (existing) return existing;
  const slugRaw = value
    .replace(/^#/, 'hex-')
    .replace(/%/g, 'pct')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'value';
  const slug = /^[A-Za-z]/.test(slugRaw) ? slugRaw : `hsl-${slugRaw}`;
  let name = slug;
  let n = 2;
  const taken = new Set(used.values());
  while (taken.has(name)) {
    name = `${slug}-${n}`;
    n += 1;
  }
  used.set(value, name);
  assertTokenName(name);
  return name;
}

export function buildLayers(byId: Map<string, SnapshotColor>): BuiltLayers {
  const used = new Map<string, string>();
  const referenceTokens: DtcgFile = {
    $description:
      'DS-3 reference 层：仅收录第一批 semantic 角色实际引用的冻结色值。',
  };
  const semantic: DtcgFile = {
    $description:
      'DS-3 semantic 层：DESIGN.md §10 Tier-1 surface/border/text/accent + status。取值来自 DS-2b 冻结快照。',
  };

  for (const role of SEMANTIC_ROLES) {
    const color = byId.get(role.id);
    if (!color) {
      throw new Error(`快照缺少 semantic 角色 ${role.id}`);
    }
    if (color.light == null || color.dark == null) {
      throw new Error(`semantic 角色 ${role.id} 缺少 light/dark 双模式值`);
    }
    const lightValue = toDtcgColorObject(color.light);
    const darkValue = toDtcgColorObject(color.dark);
    const lightName = refTokenName(color.light, used);
    const darkName = refTokenName(color.dark, used);
    if (!referenceTokens[lightName]) {
      referenceTokens[lightName] = {
        $type: 'color',
        $value: lightValue,
      };
    }
    if (!referenceTokens[darkName]) {
      referenceTokens[darkName] = {
        $type: 'color',
        $value: darkValue,
      };
    }
    if (!semantic[role.group]) {
      semantic[role.group] = {};
    }
    const group = semantic[role.group] as DtcgFile;
    group[role.id] = {
      light: {
        $type: 'color',
        $value: aliasValue([lightName]),
      },
      dark: {
        $type: 'color',
        $value: aliasValue([darkName]),
      },
    };
  }

  return { reference: referenceTokens, semantic };
}

export function resolvedSemanticValues(
  layers: BuiltLayers,
): Map<string, { light: string; dark: string }> {
  const resolved = new Map<string, { light: string; dark: string }>();
  const reference = layers.reference;
  for (const [groupName, group] of Object.entries(layers.semantic)) {
    if (groupName.startsWith('$') || !group || typeof group === 'string') continue;
    for (const [roleId, modes] of Object.entries(group as DtcgFile)) {
      if (roleId.startsWith('$') || !modes || typeof modes === 'string') continue;
      const lightAlias = (modes as DtcgFile).light as { $value: string };
      const darkAlias = (modes as DtcgFile).dark as { $value: string };
      const lightPath = lightAlias.$value.slice(1, -1);
      const darkPath = darkAlias.$value.slice(1, -1);
      const lightLeaf = reference[lightPath] as { $value: DtcgColorObject };
      const darkLeaf = reference[darkPath] as { $value: DtcgColorObject };
      resolved.set(roleId, {
        light: dtcgColorObjectToString(lightLeaf.$value),
        dark: dtcgColorObjectToString(darkLeaf.$value),
      });
    }
  }
  return resolved;
}
