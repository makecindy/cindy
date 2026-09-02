import { describe, expect, it } from 'vitest';

import { buildLayers, resolvedSemanticValues } from '../build-layers.ts';
import { dtcgColorObjectToString, toDtcgColorObject, type DtcgFile } from '../dtcg.ts';
import { SEMANTIC_ROLES } from '../semantic-roles.ts';
import {
  assertSemanticMatchesSnapshot,
  snapshotMismatch,
  validateDtcgSyntax,
} from '../guards.ts';
import { findRepoRoot } from '../paths.ts';
import { readSnapshot, snapshotById } from '../snapshot.ts';

describe('DS-3 · 逐值一致守卫', () => {
  const snapshot = readSnapshot(findRepoRoot());
  const layers = buildLayers(snapshotById(snapshot));

  it('每个 semantic 角色 light/dark 等于 DS-2b 冻结快照对应 id', () => {
    assertSemanticMatchesSnapshot(layers, snapshot);
    const resolved = resolvedSemanticValues(layers);
    expect(resolved.size).toBe(SEMANTIC_ROLES.length);
    for (const role of SEMANTIC_ROLES) {
      const frozen = snapshot.colors.find((entry) => entry.id === role.id);
      expect(frozen, snapshotMismatch(`快照缺少 ${role.id}`)).toBeTruthy();
      // resolved 还原成字符串形态后与快照语义一致（hex 大小写不敏感）。
      const value = resolved.get(role.id)!;
      expect(toDtcgColorObject(value.light)).toEqual(
        toDtcgColorObject(frozen!.light!),
      );
      expect(toDtcgColorObject(value.dark)).toEqual(
        toDtcgColorObject(frozen!.dark!),
      );
    }
  });

  it('自证伪：模拟改一个 semantic 值后守卫必然红', () => {
    const mutated = structuredClone(layers);
    const firstRef = Object.keys(mutated.reference).find((key) => !key.startsWith('$'));
    expect(firstRef).toBeTruthy();
    const leaf = mutated.reference[firstRef!] as { $value: { colorSpace: string; components: number[] } };
    // $value 现在是标准 DTCG 颜色对象；模拟「改值不更新快照」= 换一组错误分量。
    leaf.$value = { colorSpace: 'srgb', components: [0.123, 0.123, 0.123] };
    expect(() => assertSemanticMatchesSnapshot(mutated, snapshot)).toThrow(
      /与 DS-2b 冻结快照不一致/,
    );
  });

  it('标准颜色对象与快照原始字符串互逆（往返还原）', () => {
    // HSL triplet、hex、rgba、transparent 四种快照形态都必须能
    // toDtcgColorObject → dtcgColorObjectToString 还原；hex 大小写在快照里
    // 两种都有（#f8f8f6 / #EA6B17），往返按不区分大小写校验。
    const samples = [
      '60 12.5% 97%',
      '0 0% 45%',
      '#f8f8f6',
      '#EA6B17',
      'rgba(220, 38, 38, 0.4)',
      'transparent',
    ];
    for (const original of samples) {
      const roundTrip = dtcgColorObjectToString(toDtcgColorObject(original));
      expect(roundTrip.toLowerCase()).toBe(original.toLowerCase());
    }
  });

  it('自证伪：$type: "other" 不再被结构守卫放行', () => {
    // 旧实现把 12 个 HSL triplet 生成 $type: "other" 且校验器显式放行；
    // 现在自定义 $type 必须被 validateDtcgSyntax 命中（Terrazzo 会静默丢弃
    // other 类型 token，影子层不能靠非标准类型携带色值）。
    const badLayer: DtcgFile = {
      $description: 'error fixture: legacy $type other must be rejected',
      'hsl-triplet': {
        $type: 'other' as unknown as 'color',
        $value: '60 12.5% 97%',
      },
    };
    const issues = validateDtcgSyntax(badLayer, 'legacy-other');
    expect(
      issues.some((issue) => issue.code === 'invalid-syntax'),
    ).toBe(true);
  });
});
