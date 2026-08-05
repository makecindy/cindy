/**
 * ModelPickerSheet 顶部的 Claude / Codex 两段 Agent 浏览器。
 * 切段只改变正在浏览的模型目录；选中目标模型后才登记切换意图。
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';

import { Text } from '@/components/AppText';
import { MobileAgentMark } from '@/components/MobileAgentMark';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { fontWeight, iconSize, radius, spacing, typeScale } from '@/theme/tokens';

import type { MobileSessionAgentKind } from './sessionAgentSwitch';

const AGENTS: readonly { kind: MobileSessionAgentKind; label: string }[] = [
  { kind: 'claude-code', label: 'Claude' },
  { kind: 'codex', label: 'Codex' },
];

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  track: {
    alignItems: 'center',
    backgroundColor: colors.surfaceChip,
    borderColor: colors.border,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: spacing.xs,
    minHeight: 44,
    padding: spacing.xs,
  },
  segment: {
    alignItems: 'center',
    borderRadius: radius.pill,
    flex: 1,
    flexDirection: 'row',
    gap: spacing.sm,
    justifyContent: 'center',
    minHeight: 36,
    paddingHorizontal: spacing.md,
  },
  segmentActive: {
    backgroundColor: colors.cta,
  },
  segmentDisabled: {
    opacity: 0.5,
  },
  segmentPressed: {
    opacity: 0.72,
  },
  text: {
    color: colors.textTertiary,
    fontSize: typeScale.footnote,
    fontWeight: fontWeight.regular,
  },
  textActive: {
    color: colors.ctaText,
    fontWeight: fontWeight.medium,
  },
});

export interface MobileAgentSwitcherProps {
  disabled?: boolean;
  onChange(next: MobileSessionAgentKind): boolean | void | Promise<boolean | void>;
  value: MobileSessionAgentKind;
}

/** 两段切换器；异步确认期间锁住重复点击。 */
export function MobileAgentSwitcher({ disabled = false, onChange, value }: MobileAgentSwitcherProps) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const interactionDisabled = disabled || busy;

  const select = async (next: MobileSessionAgentKind) => {
    if (interactionDisabled || next === value) return;
    setBusy(true);
    try {
      await onChange(next);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View accessibilityRole="tablist" style={styles.track} testID="modelSheet.agentSwitcher">
      {AGENTS.map((agent) => {
        const active = agent.kind === value;
        const color = active ? colors.ctaText : colors.textTertiary;
        return (
          <Pressable
            accessibilityLabel={t('models.agentSwitch.browseAccessibility', { agent: agent.label })}
            accessibilityRole="tab"
            accessibilityState={{ disabled: interactionDisabled, selected: active }}
            disabled={interactionDisabled}
            key={agent.kind}
            onPress={() => void select(agent.kind)}
            style={({ pressed }) => [
              styles.segment,
              active && styles.segmentActive,
              interactionDisabled && styles.segmentDisabled,
              pressed && styles.segmentPressed,
            ]}
            testID={`modelSheet.agent.${agent.kind}`}
          >
            <MobileAgentMark agentKind={agent.kind} color={color} size={iconSize.sm} />
            <Text style={[styles.text, active && styles.textActive]}>{agent.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}
