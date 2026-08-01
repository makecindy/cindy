import { describe, expect, it } from 'vitest';

import {
  AGENT_ISLAND_CARRIER_COMPACT_INSET,
  AGENT_ISLAND_COMPACT_HARDWARE_ACTIVE_EXTRA_WIDTH,
  AGENT_ISLAND_COMPACT_HARDWARE_BADGE_RESERVED_INSET,
  AGENT_ISLAND_COMPACT_HARDWARE_HIDDEN_PULL_DISTANCE,
  AGENT_ISLAND_COMPACT_HARDWARE_IDLE_EXTRA_WIDTH,
  AGENT_ISLAND_COMPACT_IDLE_WIDTH,
  AGENT_ISLAND_MAX_RESIZABLE_WIDTH,
  getAgentIslandCompactBadgeWidth,
  getAgentIslandDefaultContentWidth,
  snapAgentIslandCompactHardwareContentWidth,
} from '../agentIsland';

/**
 * 灵动岛计数徽标由 native helper(macos-agent-island-helper.swift)绘制,但 carrier
 * 窗口宽度由这里的 TS 计算决定,两侧必须算出**完全相同**的徽标宽度:
 *
 * - TS 估小 → native 的预留被 carrier 宽度 clamp 掉,徽标被 `.clipped()` 切掉
 * - 两侧不等 → native 的吸附/持久化归一化拿 main 交付的宽度去比自己的值时永远对不上
 *   (PR #698 review 里两次踩到)
 *
 * 所以 Swift 的 `PillBadge.intrinsicWidth` 不做 NSFont 测量,而是与这里同一套按位数算的
 * 标称公式。下表的 layoutWidth 就是两侧都应算出的值;renderedWidth 是 SwiftUI 实际绘制
 * 宽度(NSHostingView 实测),标称值必须能覆盖它。
 */
const NATIVE_COMPACT_BADGE_WIDTH: Array<{
  label: string;
  pillSnapshot: { activeSessionCount: number; sessionCount: number };
  /** Swift `PillBadge.intrinsicWidth(compact: true)` 应算出的值,必须与 TS 完全一致。 */
  layoutWidth: number;
  /** SwiftUI 实绘宽度,标称宽度必须 >= 它,否则仍会被裁。 */
  renderedWidth: number;
}> = [
  { label: '单会话', pillSnapshot: { activeSessionCount: 0, sessionCount: 1 }, layoutWidth: 22, renderedWidth: 22 },
  { label: '12 个任务', pillSnapshot: { activeSessionCount: 0, sessionCount: 12 }, layoutWidth: 22, renderedWidth: 22 },
  { label: '1/2', pillSnapshot: { activeSessionCount: 1, sessionCount: 2 }, layoutWidth: 30, renderedWidth: 30 },
  { label: '9/9', pillSnapshot: { activeSessionCount: 9, sessionCount: 9 }, layoutWidth: 30, renderedWidth: 30 },
  { label: '1/12', pillSnapshot: { activeSessionCount: 1, sessionCount: 12 }, layoutWidth: 37, renderedWidth: 33 },
  { label: '11/12', pillSnapshot: { activeSessionCount: 11, sessionCount: 12 }, layoutWidth: 44, renderedWidth: 39 },
  { label: '10/100', pillSnapshot: { activeSessionCount: 10, sessionCount: 100 }, layoutWidth: 51, renderedWidth: 45 },
  { label: '99/99', pillSnapshot: { activeSessionCount: 99, sessionCount: 99 }, layoutWidth: 44, renderedWidth: 39 },
  { label: '123/456', pillSnapshot: { activeSessionCount: 123, sessionCount: 456 }, layoutWidth: 58, renderedWidth: 51 },
];

const NOTCH_WIDTHS = [180, 200, 210, 215];

/** native `CompactSessionView.hardwareNotchBody` 的侧宽公式。 */
function sideWidth(contentWidth: number, notchWidth: number): number {
  return Math.max(32, (contentWidth - notchWidth) / 2);
}

/** native `hardwareNotchSideInset(sideWidth:compactWidth:)`,compactWidth 固定 22。 */
function trailingInset(side: number): number {
  return Math.max(7, (Math.min(side, 40) - 22) / 2);
}

describe('getAgentIslandCompactBadgeWidth', () => {
  it('与 Swift PillBadge.intrinsicWidth 逐值一致(两侧公式必须同步)', () => {
    for (const { label, pillSnapshot, layoutWidth } of NATIVE_COMPACT_BADGE_WIDTH) {
      expect(getAgentIslandCompactBadgeWidth(pillSnapshot), `${label} 与 Swift 侧不一致`)
        .toBe(layoutWidth);
    }
  });

  it('标称宽度覆盖 SwiftUI 实绘宽度(否则徽标仍会被裁)', () => {
    for (const { label, pillSnapshot, renderedWidth } of NATIVE_COMPACT_BADGE_WIDTH) {
      const nominal = getAgentIslandCompactBadgeWidth(pillSnapshot);
      expect(nominal, `${label} 标称 ${nominal} < 实绘 ${renderedWidth}`)
        .toBeGreaterThanOrEqual(renderedWidth);
    }
  });

  it('单个计数在 22pt 最小宽度内不变宽,超出后同样按位数增长', () => {
    expect(getAgentIslandCompactBadgeWidth({ activeSessionCount: 0, sessionCount: 1 })).toBe(22);
    expect(getAgentIslandCompactBadgeWidth({ activeSessionCount: 0, sessionCount: 12 })).toBe(22);
    // 位数够多时单个计数也会超过最小宽度 —— 公式对两种形态都是按 segment 长度算的。
    expect(getAgentIslandCompactBadgeWidth({ activeSessionCount: 0, sessionCount: 1234 }))
      .toBeGreaterThan(22);
    const oneDigit = getAgentIslandCompactBadgeWidth({ activeSessionCount: 1, sessionCount: 2 });
    const twoDigits = getAgentIslandCompactBadgeWidth({ activeSessionCount: 11, sessionCount: 12 });
    expect(twoDigits).toBeGreaterThan(oneDigit);
  });

  it('sessionCount 为 0 时按 1 处理,不产出小于最小宽度的值', () => {
    expect(getAgentIslandCompactBadgeWidth({ activeSessionCount: 0, sessionCount: 0 })).toBe(22);
  });
});

describe('getAgentIslandDefaultContentWidth: 刻痕机为计数徽标预留宽度', () => {
  it('预留后的侧宽足够容纳 native 徽标(扣掉 trailing inset 仍装得下)', () => {
    for (const notchWidth of NOTCH_WIDTHS) {
      for (const { label, pillSnapshot, layoutWidth } of NATIVE_COMPACT_BADGE_WIDTH) {
        const contentWidth = getAgentIslandDefaultContentWidth({
          expanded: false,
          hasSession: true,
          screenMetrics: { hasNotch: true, notchWidth },
          pillSnapshot,
        });
        const side = sideWidth(contentWidth, notchWidth);
        const available = side - trailingInset(side);
        expect(
          available,
          `notch ${notchWidth} ${label}: 可用 ${available} < 徽标 ${layoutWidth}`,
        ).toBeGreaterThanOrEqual(layoutWidth);
      }
    }
  });

  it('无会话与单会话时宽度与旧实现完全一致', () => {
    for (const notchWidth of NOTCH_WIDTHS) {
      const legacyActive = Math.max(
        AGENT_ISLAND_COMPACT_IDLE_WIDTH,
        notchWidth + AGENT_ISLAND_COMPACT_HARDWARE_ACTIVE_EXTRA_WIDTH,
      );
      const legacyIdle = Math.max(
        AGENT_ISLAND_COMPACT_IDLE_WIDTH,
        notchWidth + AGENT_ISLAND_COMPACT_HARDWARE_IDLE_EXTRA_WIDTH,
      );
      expect(getAgentIslandDefaultContentWidth({
        expanded: false,
        hasSession: true,
        screenMetrics: { hasNotch: true, notchWidth },
        pillSnapshot: { activeSessionCount: 0, sessionCount: 1 },
      })).toBe(legacyActive);
      expect(getAgentIslandDefaultContentWidth({
        expanded: false,
        hasSession: false,
        screenMetrics: { hasNotch: true, notchWidth },
        pillSnapshot: { activeSessionCount: 11, sessionCount: 12 },
      })).toBe(legacyIdle);
    }
  });

  it('不传 pillSnapshot 时退回旧行为,不会意外加宽', () => {
    for (const notchWidth of NOTCH_WIDTHS) {
      expect(getAgentIslandDefaultContentWidth({
        expanded: false,
        hasSession: true,
        screenMetrics: { hasNotch: true, notchWidth },
      })).toBe(Math.max(
        AGENT_ISLAND_COMPACT_IDLE_WIDTH,
        notchWidth + AGENT_ISLAND_COMPACT_HARDWARE_ACTIVE_EXTRA_WIDTH,
      ));
    }
  });

  it('预留量等于 (徽标宽 + inset 上界) * 2', () => {
    const notchWidth = 200;
    const pillSnapshot = { activeSessionCount: 11, sessionCount: 12 };
    const badgeWidth = getAgentIslandCompactBadgeWidth(pillSnapshot);
    expect(getAgentIslandDefaultContentWidth({
      expanded: false,
      hasSession: true,
      screenMetrics: { hasNotch: true, notchWidth },
      pillSnapshot,
    })).toBe(
      notchWidth + (badgeWidth + AGENT_ISLAND_COMPACT_HARDWARE_BADGE_RESERVED_INSET) * 2,
    );
  });

  it('非刻痕机与 expanded 形态不受影响', () => {
    const pillSnapshot = { activeSessionCount: 11, sessionCount: 12 };
    const simulated = getAgentIslandDefaultContentWidth({
      expanded: false,
      hasSession: true,
      displayWidth: 1512,
      screenMetrics: { hasNotch: false, notchWidth: 210 },
      pillSnapshot,
    });
    expect(simulated).toBe(getAgentIslandDefaultContentWidth({
      expanded: false,
      hasSession: true,
      displayWidth: 1512,
      screenMetrics: { hasNotch: false, notchWidth: 210 },
    }));
    expect(getAgentIslandDefaultContentWidth({
      expanded: true,
      hasSession: true,
      screenMetrics: { hasNotch: true, notchWidth: 200 },
      pillSnapshot,
    })).toBe(getAgentIslandDefaultContentWidth({
      expanded: true,
      hasSession: true,
      screenMetrics: { hasNotch: true, notchWidth: 200 },
    }));
  });
});

/**
 * 跨语言契约:carrier 窗口宽度由 TS 算,native 只能在 `availableFrameWidth` 之内再 clamp。
 * 下面复刻 native `AgentIslandLayout.computeWidth` 的 preferred 分支(常量与
 * macos-agent-island-helper.swift 一一对应),确认 TS 交付的 carrier 不会把 native 自己的
 * 徽标预留 clamp 掉 —— 这正是 PR #698 第二轮 review 指出的失效环节。native 侧改动这段
 * 逻辑时,这里需要一起更新。
 */
function nativeCompactContentWidth(input: {
  tsContentWidth: number;
  notchWidth: number;
  nativeBadgeWidth: number;
}): number {
  const carrierWidth = Math.round(input.tsContentWidth + AGENT_ISLAND_CARRIER_COMPACT_INSET * 2);
  const availableWidth = Math.max(1, carrierWidth - AGENT_ISLAND_CARRIER_COMPACT_INSET * 2);
  const maxWidth = Math.min(AGENT_ISLAND_MAX_RESIZABLE_WIDTH, availableWidth);
  const minWidth = Math.min(Math.max(1, input.notchWidth), maxWidth);
  const clampedWidth = Math.min(maxWidth, Math.max(minWidth, input.tsContentWidth));
  const hiddenWidth = Math.min(maxWidth, Math.max(1, input.notchWidth));
  const nativeDefault = Math.max(
    AGENT_ISLAND_COMPACT_IDLE_WIDTH,
    input.notchWidth + Math.max(
      AGENT_ISLAND_COMPACT_HARDWARE_ACTIVE_EXTRA_WIDTH,
      (input.nativeBadgeWidth + AGENT_ISLAND_COMPACT_HARDWARE_BADGE_RESERVED_INSET) * 2,
    ),
  );
  const basicWidth = Math.min(maxWidth, Math.max(hiddenWidth, nativeDefault));
  const gap = basicWidth - hiddenWidth;
  if (gap <= 8) return hiddenWidth;
  const hiddenThreshold = basicWidth - Math.min(
    AGENT_ISLAND_COMPACT_HARDWARE_HIDDEN_PULL_DISTANCE,
    Math.max(24, gap * 0.5),
  );
  if (input.tsContentWidth <= hiddenThreshold) return hiddenWidth;
  if (input.tsContentWidth <= basicWidth) return basicWidth;
  return clampedWidth;
}

describe('TS carrier 宽度 → native 宽度链路', () => {
  it('native 拿到的宽度足以完整绘制徽标(carrier 不再 clamp 掉预留)', () => {
    for (const notchWidth of NOTCH_WIDTHS) {
      for (const { label, pillSnapshot, layoutWidth } of NATIVE_COMPACT_BADGE_WIDTH) {
        const tsContentWidth = getAgentIslandDefaultContentWidth({
          expanded: false,
          hasSession: true,
          screenMetrics: { hasNotch: true, notchWidth },
          pillSnapshot,
        });
        const resolved = nativeCompactContentWidth({
          tsContentWidth,
          notchWidth,
          nativeBadgeWidth: layoutWidth,
        });
        const side = sideWidth(resolved, notchWidth);
        const available = side - trailingInset(side);
        expect(
          available,
          `notch ${notchWidth} ${label}: native 解析出 ${resolved},可用 ${available} < 徽标 ${layoutWidth}`,
        ).toBeGreaterThanOrEqual(layoutWidth);
      }
    }
  });

  it('回归:旧的 TS 宽度(notch + 64)会让 native 预留被 clamp 掉', () => {
    const notchWidth = 200;
    const nativeBadgeWidth = 44; // 11/12
    const legacyTsWidth = notchWidth + AGENT_ISLAND_COMPACT_HARDWARE_ACTIVE_EXTRA_WIDTH;
    const resolved = nativeCompactContentWidth({
      tsContentWidth: legacyTsWidth,
      notchWidth,
      nativeBadgeWidth,
    });
    const side = sideWidth(resolved, notchWidth);
    expect(side - trailingInset(side)).toBeLessThan(nativeBadgeWidth);
  });
});

describe('snapAgentIslandCompactHardwareContentWidth', () => {
  it('吸附点跟随预留后的默认宽度', () => {
    const notchWidth = 200;
    const pillSnapshot = { activeSessionCount: 11, sessionCount: 12 };
    const screenMetrics = { hasNotch: true, notchWidth };
    const basicWidth = getAgentIslandDefaultContentWidth({
      expanded: false,
      hasSession: true,
      screenMetrics,
      pillSnapshot,
    });
    // 旧的默认宽度(notch + 64)现在落在吸附区间内,应被吸附到更宽的 basicWidth。
    expect(snapAgentIslandCompactHardwareContentWidth({
      desiredWidth: notchWidth + AGENT_ISLAND_COMPACT_HARDWARE_ACTIVE_EXTRA_WIDTH,
      clampedWidth: notchWidth + AGENT_ISLAND_COMPACT_HARDWARE_ACTIVE_EXTRA_WIDTH,
      maxWidth: 920,
      hasSession: true,
      screenMetrics,
      pillSnapshot,
    })).toBe(basicWidth);
  });

  it('用户拖到很窄时仍吸附回隐藏宽度(拖窄是显式意图)', () => {
    const notchWidth = 200;
    expect(snapAgentIslandCompactHardwareContentWidth({
      desiredWidth: notchWidth,
      clampedWidth: notchWidth,
      maxWidth: 920,
      hasSession: true,
      screenMetrics: { hasNotch: true, notchWidth },
      pillSnapshot: { activeSessionCount: 11, sessionCount: 12 },
    })).toBe(notchWidth);
  });

  it('计数变多不会把此前停在 basic 的持久化宽度判成 hidden(灵动岛不塌缩)', () => {
    // 回归:三位数徽标把 basicWidth 撑到 320,若 hidden 阈值也跟着抬到 272,
    // 用户此前存下的 basic 宽度 264 会被判成 hidden,整个 compact 岛被收起。
    const notchWidth = 200;
    const persistedBasicWidth = notchWidth + AGENT_ISLAND_COMPACT_HARDWARE_ACTIVE_EXTRA_WIDTH;
    const screenMetrics = { hasNotch: true, notchWidth };
    for (const pillSnapshot of [
      { activeSessionCount: 10, sessionCount: 100 },
      { activeSessionCount: 11, sessionCount: 12 },
      { activeSessionCount: 123, sessionCount: 456 },
    ]) {
      const widened = getAgentIslandDefaultContentWidth({
        expanded: false,
        hasSession: true,
        screenMetrics,
        pillSnapshot,
      });
      const resolved = snapAgentIslandCompactHardwareContentWidth({
        desiredWidth: persistedBasicWidth,
        clampedWidth: persistedBasicWidth,
        maxWidth: 920,
        hasSession: true,
        screenMetrics,
        pillSnapshot,
      });
      expect(resolved, `${pillSnapshot.activeSessionCount}/${pillSnapshot.sessionCount} 塌缩到了 ${resolved}`)
        .not.toBe(notchWidth);
      expect(resolved).toBe(widened);
    }
  });

  it('hidden 阈值与旧实现一致:略窄于旧 basic 仍吸附到 basic,更窄才隐藏', () => {
    const notchWidth = 200;
    const screenMetrics = { hasNotch: true, notchWidth };
    const pillSnapshot = { activeSessionCount: 11, sessionCount: 12 };
    const widened = getAgentIslandDefaultContentWidth({
      expanded: false,
      hasSession: true,
      screenMetrics,
      pillSnapshot,
    });
    // 旧 basic 264、hidden 200、gap 64 → 阈值 264 - 32 = 232。
    expect(snapAgentIslandCompactHardwareContentWidth({
      desiredWidth: 240,
      clampedWidth: 240,
      maxWidth: 920,
      hasSession: true,
      screenMetrics,
      pillSnapshot,
    })).toBe(widened);
    expect(snapAgentIslandCompactHardwareContentWidth({
      desiredWidth: 230,
      clampedWidth: 230,
      maxWidth: 920,
      hasSession: true,
      screenMetrics,
      pillSnapshot,
    })).toBe(notchWidth);
  });

  it('持久化的是与徽标无关的 basic 宽度时,计数升降都能正确跟随', () => {
    // native 侧 `persistedCompactContentWidth` 保证停在 basic 吸附位时存下的是
    // 与计数无关的 baseBasicWidth,这里验证存下该标量后两个方向都归一到当前 basic。
    const notchWidth = 200;
    const screenMetrics = { hasNotch: true, notchWidth };
    const persisted = notchWidth + AGENT_ISLAND_COMPACT_HARDWARE_ACTIVE_EXTRA_WIDTH;
    const resolveFor = (pillSnapshot: { activeSessionCount: number; sessionCount: number }) =>
      snapAgentIslandCompactHardwareContentWidth({
        desiredWidth: persisted,
        clampedWidth: persisted,
        maxWidth: 920,
        hasSession: true,
        screenMetrics,
        pillSnapshot,
      });

    const wide = resolveFor({ activeSessionCount: 11, sessionCount: 12 });
    const narrow = resolveFor({ activeSessionCount: 0, sessionCount: 1 });
    expect(wide).toBeGreaterThan(persisted);
    // 计数回落后必须收缩回旧的 basic 宽度,不能停在为宽徽标撑开的宽度上。
    expect(narrow).toBe(persisted);
    expect(narrow).toBeLessThan(wide);
  });

  it('介于旧 basic 与新 basic 之间的自由宽度不被吞掉', () => {
    // 回归:用户此前把岛拖到 280(旧 basic 264 之上,属自由宽度)。若按放大后的 basicWidth
    // 判定,280 会被"升级"成 306,再被 native 的持久化归一化写回 264,永久覆盖用户偏好。
    const notchWidth = 200;
    const screenMetrics = { hasNotch: true, notchWidth };
    const baseBasic = notchWidth + AGENT_ISLAND_COMPACT_HARDWARE_ACTIVE_EXTRA_WIDTH;
    for (const pillSnapshot of [
      { activeSessionCount: 11, sessionCount: 12 },
      { activeSessionCount: 123, sessionCount: 456 },
    ]) {
      const widened = getAgentIslandDefaultContentWidth({
        expanded: false,
        hasSession: true,
        screenMetrics,
        pillSnapshot,
      });
      for (const freeWidth of [baseBasic + 16, widened - 4]) {
        expect(
          snapAgentIslandCompactHardwareContentWidth({
            desiredWidth: freeWidth,
            clampedWidth: freeWidth,
            maxWidth: 920,
            hasSession: true,
            screenMetrics,
            pillSnapshot,
          }),
          `自由宽度 ${freeWidth} 被吸附掉了`,
        ).toBe(freeWidth);
      }
      // 恰好停在旧 basic 吸附位的仍然跟随到新 basic。
      expect(snapAgentIslandCompactHardwareContentWidth({
        desiredWidth: baseBasic,
        clampedWidth: baseBasic,
        maxWidth: 920,
        hasSession: true,
        screenMetrics,
        pillSnapshot,
      })).toBe(widened);
    }
  });

  it('不传 pillSnapshot 时吸附行为与旧实现完全一致', () => {
    const notchWidth = 200;
    const screenMetrics = { hasNotch: true, notchWidth };
    const legacyBasic = notchWidth + AGENT_ISLAND_COMPACT_HARDWARE_ACTIVE_EXTRA_WIDTH;
    for (const [desiredWidth, expected] of [
      [legacyBasic, legacyBasic],
      [240, legacyBasic],
      [230, notchWidth],
      [notchWidth, notchWidth],
    ] as Array<[number, number]>) {
      expect(snapAgentIslandCompactHardwareContentWidth({
        desiredWidth,
        clampedWidth: desiredWidth,
        maxWidth: 920,
        hasSession: true,
        screenMetrics,
      })).toBe(expected);
    }
  });
});
