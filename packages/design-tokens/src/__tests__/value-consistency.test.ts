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

  it('自证伪：分量超出色彩空间合法范围被拒（hsl s/l 是 0–100，srgb 是 0–1）', () => {
    // DTCG Color 模块的 Color Space 表：hsl hue [0,360)、saturation/lightness
    // [0,100]；srgb 三通道 [0,1]；alpha [0,1]。曾有意见把 hsl 误读成 0–1
    // （会把 12.5% 写成 0.125——Terrazzo 实测渲染成 hsl(60 0.125% 0.97%)，
    // 几乎全黑）。0.125 在 0–100 内语法合法但颜色错误，机器分不出语义，
    // 这里锁的是真正的越界形态：
    const srgbOverflow: DtcgFile = {
      $description: 'error fixture: srgb channel overflow',
      bad: {
        $type: 'color',
        $value: { colorSpace: 'srgb', components: [1.2, 0, 0] },
      },
    };
    expect(
      validateDtcgSyntax(srgbOverflow, 'srgb-overflow').some(
        (issue) => issue.code === 'invalid-syntax',
      ),
    ).toBe(true);

    const hue360: DtcgFile = {
      $description: 'error fixture: hue must be [0,360) — 360 itself is illegal',
      bad: {
        $type: 'color',
        $value: { colorSpace: 'hsl', components: [360, 0, 0] },
      },
    };
    expect(
      validateDtcgSyntax(hue360, 'hue-360').some(
        (issue) => issue.code === 'invalid-syntax',
      ),
    ).toBe(true);

    const lightnessOver100: DtcgFile = {
      $description: 'error fixture: hsl lightness beyond 100',
      bad: {
        $type: 'color',
        $value: { colorSpace: 'hsl', components: [60, 12.5, 100.5] },
      },
    };
    expect(
      validateDtcgSyntax(lightnessOver100, 'lightness-over-100').some(
        (issue) => issue.code === 'invalid-syntax',
      ),
    ).toBe(true);

    // 对照：合法范围（0–100 的 hsl 分量、0–1 的 srgb 通道）必须放行。
    const legal: DtcgFile = {
      $description: 'legal ranges pass',
      okHsl: { $type: 'color', $value: { colorSpace: 'hsl', components: [60, 12.5, 97] } },
      okSrgb: { $type: 'color', $value: { colorSpace: 'srgb', components: [0.973, 0.973, 0.965] } },
    };
    expect(validateDtcgSyntax(legal, 'legal-ranges')).toEqual([]);
  });
});
